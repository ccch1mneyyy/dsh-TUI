/**
 * Claude Agent SDK → Agent Domain translator: one pure state machine per
 * session that turns the SDK message stream (including the frames the SDK
 * types do not declare — `command_lifecycle`, `session_state_changed`,
 * `thinking_tokens` estimates) into `AgentEvent`s for the
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
import type { AgentEvent, AgentEventOf, ImageRef, PendingItem } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { arr, num, rec, str, type Rec } from '../narrow.js'
import { BASH_OUTPUT, narrationOf } from './content.js'
import { createAttemptTranslator, MAX_SETTLED_ATTEMPTS } from './attempts.js'
import { createLaneTranslator } from './lanes.js'
import { createMessageTranslator } from './messages.js'
import { createSystemTranslator } from './system.js'
import { createTaskTools } from './tasks.js'
import type { ClaudeActivityState, ClaudeTranslatorOptions, ClaudeUserRows, OpenAttempt, RegisteredInput, TrackedTask } from './types.js'

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
  /** API message ids already settled (late duplicate blocks are ignored);
   *  only the most recent {@link MAX_SETTLED_ATTEMPTS} are remembered. */
  const settledAttempts = new Set<string>()
  const openCalls = new Map<string, { readonly name: string; readonly input: unknown; readonly turn: number; readonly lane?: string }>()
  const inputs = new Map<string, RegisteredInput>()
  /** Registered inputs the CLI already started whose echo (the user row of
   *  the replay fallback) has not arrived yet. */
  const startedInputs = new Set<string>()
  /** Inputs the channel still shows as queued (pending previews). */
  const pending = new Map<string, PendingItem>()

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

  /** Why the CLI auto-denied a call (`system/permission_denied`), until its
   *  error result lands on the card. */
  const deniedReasons = new Map<string, string>()

  const tasks = createTaskTools(options)

  /** Wall clock the open (or last) turn began (the activity fold's anchor). */
  let turnTime = 0
  /** Main-lane tool results settled in the open turn (the fold's toolCount). */
  let toolResults = 0
  /** The turn's latest complete ⏵ narration line (survives the attempt
   *  that streamed it — the working line keeps narrating between responses,
   *  like the DSH plugin's freshness window). */
  let narrated: string | undefined

  const nextSeq = (): number => ++seq
  const { closeStep, openTurn, settleAttempt, ensureAttempt, delta, translateStream, translateResult, forceCloseTurn } = createAttemptTranslator({
    now,
    nextSeq,
    settledAttempts,
    get stepOpen() { return stepOpen },
    set stepOpen(value) { stepOpen = value },
    get step() { return step },
    set step(value) { step = value },
    get turn() { return turn },
    set turn(value) { turn = value },
    get turnOpen() { return turnOpen },
    set turnOpen(value) { turnOpen = value },
    get turnTime() { return turnTime },
    set turnTime(value) { turnTime = value },
    get toolResults() { return toolResults },
    set toolResults(value) { toolResults = value },
    get narrated() { return narrated },
    set narrated(value) { narrated = value },
    get notificationTurnExpected() { return notificationTurnExpected },
    set notificationTurnExpected(value) { notificationTurnExpected = value },
    get currentModel() { return currentModel },
    set currentModel(value) { currentModel = value },
    get attempt() { return attempt },
    set attempt(value) { attempt = value },
    get compactRequested() { return compactRequested },
    set compactRequested(value) { compactRequested = value },
  })

  /** The user row for a confirmed input (lifecycle `started` / replay echo). */
  const confirmInput = (out: AgentEvent[], uuid: string): void => {
    const input = inputs.get(uuid)
    if (pending.delete(uuid)) out.push({ type: 'pending.changed', items: [...pending.values()], claimed: [uuid] })
    // Started while a turn is open = folded into that turn: a user row, no
    // new turn. Only an input this session pushed makes the
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

  /**
   * The conversation is gone (a reset): the CLI continues under a new
   * session id with a cleared context, so the old conversation's tasks,
   * unsettled main-lane calls and expectation markers must
   * not leak into the new one (the CLI reuses short task ids). Kept: the
   * queued inputs (they still run), the monotonic turn / seq numbering (the
   * projector binds by position), and background tasks that have not ended
   * (their notification still arrives).
   */
  const clearMainCalls = (): void => {
    for (const [callId, call] of openCalls) if (call.lane === undefined) openCalls.delete(callId)
  }

  const resetConversation = (): void => {
    tasks.trackedTasks.clear()
    tasks.taskSeq = 0
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

  const { translateSystem, rateLimitNotice } = createSystemTranslator({
    options,
    taskKinds,
    taskInfo,
    laneTasks,
    outputFiles,
    hiddenTasks,
    openCalls,
    deniedReasons,
    now,
    debug,
    openTurn,
    delta,
    forceCloseTurn,
    get currentModel() { return currentModel },
    set currentModel(value) { currentModel = value },
    get currentMode() { return currentMode },
    set currentMode(value) { currentMode = value },
    get summaryExpected() { return summaryExpected },
    set summaryExpected(value) { summaryExpected = value },
    get notificationTurnExpected() { return notificationTurnExpected },
    set notificationTurnExpected(value) { notificationTurnExpected = value },
    get turnOpen() { return turnOpen },
    get compactRequested() { return compactRequested },
    get attempt() { return attempt },
  })
  const { delegation, translateLane } = createLaneTranslator({
    options,
    openCalls,
    outputFiles,
    now,
    nextSeq,
    debug,
    get seq() { return seq },
    get turn() { return turn },
    get step() { return step },
  })
  const { translateAssistant, translateUser } = createMessageTranslator({
    options,
    inputs,
    openCalls,
    deniedReasons,
    outputFiles,
    tasks,
    now,
    nextSeq,
    debug,
    ensureAttempt,
    settleAttempt,
    confirmInput,
    delegation,
    get userRows() { return userRows },
    get seq() { return seq },
    get turn() { return turn },
    get step() { return step },
    get currentMode() { return currentMode },
    set currentMode(value) { currentMode = value },
    get toolResults() { return toolResults },
    set toolResults(value) { toolResults = value },
    get summaryExpected() { return summaryExpected },
    set summaryExpected(value) { summaryExpected = value },
  })

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
    clearInterruptedCalls(): void { clearMainCalls() },
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
      // Read after every streamed delta: plain scans, no copies. Only this
      // turn's calls count: a call the turn left unsettled is stale (the CLI
      // moved on), so the working line never shows the last turn's tool.
      let newest: { readonly name: string; readonly input: unknown } | undefined
      for (const call of openCalls.values()) if (call.turn === turn) newest = call
      // The first-created in_progress task that has a spinner line.
      let inProgress: TrackedTask | undefined
      for (const task of tasks.trackedTasks.values()) {
        if (task.status !== 'in_progress' || task.activeForm === undefined || task.activeForm === '') continue
        if (inProgress === undefined || task.seq < inProgress.seq) inProgress = task
      }
      return {
        turnOpen,
        turnStartedAt: turnTime,
        openTool: newest === undefined ? undefined : { name: newest.name, input: newest.input },
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
    taskSeeds: tasks.taskSeeds,
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
