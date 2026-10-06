/**
 * The backend-neutral trajectory source: an incremental fold of the shared
 * AgentEvent vocabulary into the raw-event envelope the trajectory
 * projection already consumes.
 *
 * `/trace` and the trajectory panel fold {@link RawTrajEvent}s, the DSH
 * session log's vocabulary. A session without that log (Claude) still
 * streams the same AgentEvents every backend translator emits, so this
 * module translates them for any composition that has no raw log. The
 * channel reports 'empty' until the first mapped event and 'supported'
 * from then on; 'unsupported' is left for a composition with no source.
 *
 * ## The mapping table
 *
 * | AgentEvent | Raw event | Notes |
 * |---|---|---|
 * | `turn.start`/`turn.end` | `turn/start`/`turn/end` | turn-level usage rides the close, backfilled by the fold only when no message of the turn carried usage (no double counting). |
 * | `step.start`/`step.end` | `step/start`/`step/end` | no timestamps in the vocabulary → trace clock, marked `observed`. |
 * | attempt supersede / `api-retry` notice | `llm/retry` (+ `llm/retry-started` on the next attempt) | one row per retry attempt; backoff delay is unknown to the vocabulary → 0. |
 * | `assistant.delta` (text/reasoning/tool-args) | `assistant/chunk` | first/last-chunk timing for TTFT and decode. |
 * | `assistant.delta` (`reasoning-tokens`) | — (estimate) | accumulated per attempt; surfaces as a thinking row when the settled message carries no reasoning text. |
 * | `assistant.message` | `assistant/message` | message-level usage (the authoritative token count) attaches to the first row exactly once. |
 * | `tool.call`/`tool.result` | `tool/call`/`tool/result` | paired by `callId`; args/result stay references (the inspector re-reads lazily). |
 * | `tool.progress` | — | consumed; a running row's spinner is already live, an elapsed echo would add a row per poll. |
 * | `tool.output` | — | consumed; live output is display-only, the settled result carries the record. |
 * | `permission.request`/`settled` | `approval/asked`/`approval/decided` | paired by `requestId`; the asked payload also records the wait-detail fields (source identity, offered options). |
 * | `question.request`/`settled` | `approval/asked`/`approval/decided` | the questionnaire as an approval-shaped bracket; the asked payload carries a bounded question snapshot. |
 * | `compaction.start`/`end` | `compaction/start`/`compaction/end` | `removed` derived from pre/post tokens when both are known. |
 * | `subagent.start` | `subagent/descriptor` | the child lane's presence row (carrying `agentId` as the drilldown anchor); the child's own assistant/tool traffic is folded into a SEPARATE per-agent lane log (below), never into the main ledger — the delegating tool bracket already spans it there — and subagent usage never enters the parent's token totals. |
 * | `user.message` | `user/message` | human prompts as user rows, injected/goal/compaction output as context rows. |
 * | `todo.write` | `todo/write` | parity with the DSH row. |
 *
 * ## Lanes (cross-agent drilldown)
 *
 * The vocabulary marks child-lane traffic ONLY through `parentCallId` (the
 * delegating tool call). `subagent.start` registers that call id against the
 * child's `agentId`; afterwards every parentCallId-carrying event folds
 * into that agent's own raw-event log instead of the main one. The main
 * lane's output is therefore byte-identical to the pre-lane fold — child
 * traffic was already skipped there — while `lanes()` / `laneEvents()` /
 * `descendantEvents()` expose the child logs the trajectory's scope filter
 * (当前 Agent / 父回合 / 全部后代) refolds on demand. A second
 * `subagent.start` for the same anchor call (a backend that learns the
 * child's own id late) re-keys the lane and keeps the earlier events: they
 * are adopted by the new id, in seq order.
 *
 * ## Clocks, identity, immutability
 *
 * Events without a timestamp take the trace clock (`Date.now` at receipt)
 * and carry `data.observed = true` so the inspector can mark the row's time
 * as an observation rather than a backend fact. `seq` is this source's own
 * monotonic counter: durable `seq`s the vocabulary carries are used ONLY for
 * deduplication (a reconnect may replay a durable chunk), never as envelope
 * identity — the envelope stays monotonic in emission order for the
 * inspector's binary search. Emitted events and payloads are frozen. The
 * current attempt's tail chunk may be replaced in a new snapshot; older
 * snapshots remain unchanged. Merged descendants rebuild when a lane changes.
 */

import type { AgentEvent } from '../../agent/events.js'
import type { RawTrajEvent } from './guards.js'
import type { TrajectoryLane } from './types.js'

/** The neutral source a backend-neutral composition mounts. */
export interface AgentTrajectorySource {
  /** Fold one stream event (live or replayed) into the raw-event log. */
  observe(event: AgentEvent, replaying: boolean): void
  /** Forget everything: a session swap or an in-place conversation reset. */
  reset(): void
  /** The raw-event snapshot (`traceEvents()`'s return). */
  events(): readonly RawTrajEvent[]
  /** Every registered child lane, in registration order (drilldown roster). */
  lanes(): readonly TrajectoryLane[]
  /** One lane's raw-event snapshot. */
  laneEvents(agentId: string): readonly RawTrajEvent[]
  /** The agent's subtree merged in emission order (agent + all descendants). */
  descendantEvents(agentId: string): readonly RawTrajEvent[]
}

/** Freeze a bounded list of display labels (ask-time option/question text). */
function freezeLabels(labels: readonly string[]): readonly string[] {
  return Object.freeze([...labels])
}

/** One streamed attempt whose reasoning estimate is still accumulating. */
interface OpenAttempt {
  readonly attemptId: string
  readonly turn: number
  readonly step: number
  /** Summed `reasoning-tokens` estimates of this attempt. */
  thinkEstimated: number
  firstChunkIndex: number | undefined
  lastChunkIndex: number | undefined
}

/**
 * One lane's fold state — the per-lane slice of the pre-lane closure
 * scalars. The main session lane is the instance whose `agentId` is
 * undefined; a child lane's events never interleave with the main fold's
 * bookkeeping (turn context, open attempt, retry brackets), so each lane
 * needs its own.
 */
interface LaneFold {
  /** Undefined for the main session lane; the subagent id for a child lane. */
  readonly agentId: string | undefined
  emitted: RawTrajEvent[]
  /**
   * The published snapshot, rebuilt lazily after a lane change.
   */
  snapshot: readonly RawTrajEvent[] | undefined
  /** Durable identities already folded into THIS lane (`type#seq`). */
  readonly seen: Set<string>
  turn: number
  attempt: OpenAttempt | undefined
  /** Retry rows opened this turn, closed by the next attempt or turn end. */
  openRetry: { readonly retryId: string; readonly attempts: number } | undefined
  retryCount: number
  /** A retry was already signaled since the current attempt opened: one
   * failure produces at most one row, whichever signal carried it (an
   * `api-retry` toast, a superseded attempt start, or an abandoned end). */
  retrySignaled: boolean
}

/** A registered child lane: its {@link TrajectoryLane} facts plus its fold. */
interface LaneRecord extends TrajectoryLane {
  readonly fold: LaneFold
}

/** Fresh lane state; the main lane shares the module's global seq counter. */
function newFold(agentId: string | undefined): LaneFold {
  return {
    agentId,
    emitted: [],
    snapshot: Object.freeze([]),
    seen: new Set<string>(),
    turn: 0,
    attempt: undefined,
    openRetry: undefined,
    retryCount: 0,
    retrySignaled: false,
  }
}

/**
 * Create the source. `clock` is injectable so regressions can pin the
 * observation timestamps; it defaults to `Date.now`.
 */
export function createAgentTrajectorySource(options?: { readonly clock?: () => number }): AgentTrajectorySource {
  const clock = options?.clock ?? (() => Date.now())
  let main = newFold(undefined)
  /** Envelope seq — monotonic in emission order, this source's own. Shared
   *  across lanes so a merged descendants snapshot stays seq-sorted. */
  let seq = 0
  /** Registered child lanes by agentId (insertion = registration order). */
  const lanes = new Map<string, LaneRecord>()
  /** Delegating tool call id → the agent it spawned (the lane router). */
  const laneByCall = new Map<string, string>()
  /** Emitted tool call id → the lane that owns it (the lane tree's edges). */
  const callLane = new Map<string, string | undefined>()
  /** A re-keyed lane's old id → its new id (late id learning). */
  const laneAlias = new Map<string, string>()
  /** Bumped whenever any child lane's log grows; gates the merged cache. */
  let laneVersion = 0
  let mergedCache: { readonly agentId: string; readonly version: number; readonly snapshot: readonly RawTrajEvent[] } | undefined

  const emitInto = (fold: LaneFold, type: string, time: number | undefined, data: Record<string, unknown>, replaceIndex?: number): void => {
    const observed = time === undefined || !Number.isFinite(time)
    const previous = replaceIndex === undefined ? undefined : fold.emitted[replaceIndex]
    const eventSeq = previous?.seq ?? ++seq
    const event = Object.freeze({
      type,
      seq: eventSeq,
      time: observed ? clock() : time,
      data: Object.freeze(observed ? { ...data, observed: true } : data),
    })
    if (replaceIndex === undefined) fold.emitted.push(event)
    else fold.emitted[replaceIndex] = event
    fold.snapshot = undefined
    if (fold.agentId !== undefined) laneVersion += 1
  }

  /** True (and remembers) when a durable-seq event was already folded. */
  const duplicate = (fold: LaneFold, kind: string, durable: number | undefined): boolean => {
    if (durable === undefined || !Number.isFinite(durable)) return false
    const key = `${kind}#${durable}`
    if (fold.seen.has(key)) return true
    fold.seen.add(key)
    return false
  }

  /** Close the turn's open retry bracket (`llm/retry-started`). */
  const closeRetry = (fold: LaneFold): void => {
    if (fold.openRetry === undefined) return
    emitInto(fold, 'llm/retry-started', undefined, { retryId: fold.openRetry.retryId })
    fold.openRetry = undefined
  }

  /** One retry signal: a superseded/abandoned attempt or an api-retry toast. */
  const noteRetry = (fold: LaneFold, message: string | undefined): void => {
    fold.retryCount += 1
    // One row per signal: each closes when the replacement attempt starts
    // (or the turn ends), so a twice-retried turn shows two honest rows
    // rather than one row claiming a backoff ladder the source never saw.
    const retryId = `retry:${fold.turn}:${fold.retryCount}`
    fold.openRetry = { retryId, attempts: 1 }
    fold.retrySignaled = true
    emitInto(fold, 'llm/retry', undefined, {
      retryId,
      retry: fold.retryCount,
      delayMs: 0,
      ...(message === undefined ? {} : { failure: { message } }),
    })
  }

  const usageOf = (usage: { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number } | undefined, think: number | undefined): Record<string, number> | undefined => {
    if (usage === undefined && think === undefined) return undefined
    const value = {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      think: think ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
    }
    return value.input + value.output + value.think + value.cacheRead + value.cacheWrite > 0 ? value : undefined
  }

  /**
   * Register (or re-key) a child lane. Called from the `subagent.start`
   * arm before the descriptor row is emitted, so the lane exists by the
   * time any of its traffic arrives.
   */
  const registerLane = (event: Extract<AgentEvent, { readonly type: 'subagent.start' }>): void => {
    const callId = event.parentCallId
    // The lane owning the delegating call is this lane's parent — a
    // grandchild's anchor call was emitted inside the child's lane.
    const parentAgentId = callId === undefined ? undefined : callLane.get(callId)
    const parent = parentAgentId === undefined ? undefined : lanes.get(parentAgentId)
    // Re-key: the same anchor call already spawned a lane whose id the
    // backend has since learned to name properly. The earlier events stay
    // (adopted by the new id, in seq order — they all precede this moment).
    const previousId = callId === undefined ? undefined : laneByCall.get(callId)
    if (previousId !== undefined && previousId !== event.agentId) {
      const previous = lanes.get(previousId)
      if (previous !== undefined) {
        const adopted = previous.fold.emitted
        lanes.delete(previousId)
        laneAlias.set(previousId, event.agentId)
        const fold = newFold(event.agentId)
        fold.emitted = adopted
        fold.snapshot = undefined
        const record: LaneRecord = {
          agentId: event.agentId,
          ...(callId === undefined ? {} : { callId }),
          ...(event.description === '' ? {} : { label: event.description }),
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(parentAgentId === undefined ? {} : { parentAgentId }),
          depth: (parent?.depth ?? 0) + 1,
          fold,
        }
        lanes.set(event.agentId, record)
        if (callId !== undefined) laneByCall.set(callId, event.agentId)
        laneVersion += 1
        return
      }
    }
    if (lanes.has(event.agentId)) return
    const record: LaneRecord = {
      agentId: event.agentId,
      ...(callId === undefined ? {} : { callId }),
      ...(event.description === '' ? {} : { label: event.description }),
      ...(event.model === undefined ? {} : { model: event.model }),
      ...(parentAgentId === undefined ? {} : { parentAgentId }),
      depth: (parent?.depth ?? 0) + 1,
      fold: newFold(event.agentId),
    }
    lanes.set(event.agentId, record)
    if (callId !== undefined) laneByCall.set(callId, event.agentId)
  }

  /** Fold one event into one lane's state (the mapping table itself). */
  const foldEvent = (fold: LaneFold, event: AgentEvent): void => {
    switch (event.type) {
      case 'turn.start': {
        // Turn numbers are monotonic within one binding (a conversation
        // reset or a session swap resets the whole fold), so a REPLAYED
        // turn start with a number already folded is a reconnect echo —
        // deduplicated like the durable-seq events, or every replayed
        // batch would grow a second bracket row.
        if (fold.seen.has('turn-start#' + event.turn)) return
        fold.seen.add('turn-start#' + event.turn)
        closeRetry(fold)
        fold.turn = event.turn
        emitInto(fold, 'turn/start', event.time, { turn: event.turn })
        return
      }
      case 'turn.end': {
        closeRetry(fold)
        // Turn-level usage is the CLOSE event's payload; the projection
        // backfills it onto the turn row only when no message of the turn
        // carried usage — the two levels are distinguished, never summed.
        const usage = usageOf(event.usage, undefined)
        emitInto(fold, 'turn/end', event.time, {
          turn: event.turn,
          reason: event.reason,
          ...(usage === undefined ? {} : { usage }),
        })
        return
      }
      case 'step.start': {
        const key = 'step-start#' + event.turn + ':' + event.step
        if (fold.seen.has(key)) return
        fold.seen.add(key)
        emitInto(fold, 'step/start', undefined, { turn: event.turn, step: event.step })
        return
      }
      case 'step.end': {
        emitInto(fold, 'step/end', undefined, { turn: event.turn, step: event.step })
        return
      }
      case 'assistant.attempt.start': {
        // A supersede means the replaced attempt failed and will be
        // retried; the retry row is the honest trace of that failure —
        // unless the failure already announced itself (the api-retry toast).
        if (fold.attempt !== undefined && fold.attempt.attemptId !== event.attemptId && !fold.retrySignaled) {
          closeRetry(fold)
          noteRetry(fold, undefined)
        }
        closeRetry(fold)
        fold.retrySignaled = false
        fold.attempt = { attemptId: event.attemptId, turn: event.turn, step: event.step, thinkEstimated: 0, firstChunkIndex: undefined, lastChunkIndex: undefined }
        return
      }
      case 'assistant.attempt.end': {
        if (fold.attempt?.attemptId === event.attemptId) fold.attempt = undefined
        if (event.outcome !== 'committed' && !fold.retrySignaled) { closeRetry(fold); noteRetry(fold, undefined) }
        return
      }
      case 'assistant.delta': {
        if (event.delta.kind === 'reasoning-tokens') {
          if (fold.attempt !== undefined && fold.attempt.attemptId === event.attemptId) {
            fold.attempt.thinkEstimated += event.delta.estimated
          }
          return
        }
        if (event.delta.kind === 'other') return
        if (event.seq !== undefined) {
          if (duplicate(fold, 'delta', event.seq)) return
        } else if ((fold.attempt === undefined || fold.attempt.attemptId !== event.attemptId)
          && (event.turn === undefined || event.step === undefined)) {
          return
        }
        const position = event.turn !== undefined && event.step !== undefined
          ? { turn: event.turn, step: event.step }
          : fold.attempt
        if (position === undefined) return
        // Preserve the first chunk and keep the latest chunk in one replaceable slot.
        let current = fold.attempt?.attemptId === event.attemptId ? fold.attempt : undefined
        if (current === undefined) {
          current = { attemptId: event.attemptId, turn: position.turn, step: position.step, thinkEstimated: 0, firstChunkIndex: undefined, lastChunkIndex: undefined }
          fold.attempt = current
        }
        if (current.firstChunkIndex === undefined) {
          const index = fold.emitted.length
          emitInto(fold, 'assistant/chunk', event.time, { turn: position.turn, step: position.step })
          current.firstChunkIndex = index
        } else if (current.lastChunkIndex === undefined) {
          current.lastChunkIndex = fold.emitted.length
          emitInto(fold, 'assistant/chunk', event.time, { turn: position.turn, step: position.step })
        } else {
          emitInto(fold, 'assistant/chunk', event.time, { turn: position.turn, step: position.step }, current.lastChunkIndex)
        }
        return
      }
      case 'assistant.message': {
        // A usage report is not a message: nothing to show on the ledger.
        if (event.usageOnly === true) return
        if (duplicate(fold, 'assistant.message', event.seq)) return
        const mine = fold.attempt?.attemptId === event.attemptId ? fold.attempt : undefined
        if (mine !== undefined) fold.attempt = undefined
        const estimate = mine?.thinkEstimated
        // Legacy history may settle without position; the tracked attempt
        // of the same id is then the only locator the source has.
        const position = event.turn !== undefined ? event : mine
        const hasReasoning = event.blocks.some(block => block.type === 'reasoning' && (block.text ?? '').trim() !== '')
        const blocks = [...event.blocks]
        if (!hasReasoning && estimate !== undefined && estimate > 0) {
          // Redacted thinking left only a count: one thinking row that
          // says so, instead of silently dropping the model's reasoning
          // cost. Same marker style as the DSH `effort=` detail.
          blocks.unshift({ type: 'reasoning', text: `≈ ${estimate} tokens` })
        }
        const usage = usageOf(event.usage, estimate)
        emitInto(fold, 'assistant/message', event.time, {
          turn: position?.turn ?? fold.turn,
          ...(position?.step === undefined ? {} : { step: position.step }),
          message: { content: blocks },
          ...(usage === undefined ? {} : { usage }),
        })
        return
      }
      case 'tool.call': {
        if (duplicate(fold, 'tool.call', event.seq)) return
        // The call's owning lane is the tree edge a NESTED subagent.start
        // resolves its parent through (grandchild anchoring).
        callLane.set(event.callId, fold.agentId)
        emitInto(fold, 'tool/call', event.time, {
          turn: event.turn,
          step: event.step,
          callId: event.callId,
          name: event.name,
          arguments: event.argsJson,
        })
        return
      }
      case 'tool.result': {
        if (duplicate(fold, 'tool.result', event.seq)) return
        emitInto(fold, 'tool/result', event.time, {
          turn: event.turn,
          step: event.step,
          message: {
            source: { callId: event.callId },
            content: [{ type: 'text', text: event.errorText ?? event.text }],
          },
          ...(event.isError ? { error: {} } : {}),
        })
        return
      }
      case 'tool.progress':
      case 'tool.output': {
        // Consumed, no row: a running row is already live in the ledger
        // and the wave band; an elapsed echo would add one row per poll,
        // and live output is display-only (the result carries the record).
        return
      }
      case 'permission.request': {
        const request = event.request
        emitInto(fold, 'approval/asked', undefined, {
          id: request.requestId,
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          ...(request.reason === undefined && request.title === undefined && request.displayName === undefined
            ? {}
            : { reason: request.reason ?? request.title ?? request.displayName }),
          // 来源与可选项只能在 asked 时记录：settled 事件只带 outcome。
          // 有界拷贝（≤8 个选项标签）。
          ask: 'permission',
          ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.command === undefined ? {} : { command: request.command }),
          ...(request.blockedPath === undefined ? {} : { blockedPath: request.blockedPath }),
          ...(request.options.length === 0
            ? {}
            : { options: freezeLabels(request.options.slice(0, 8).map(option => option.label ?? option.kind)) }),
        })
        return
      }
      case 'permission.settled': {
        emitInto(fold, 'approval/decided', undefined, { id: event.requestId, outcome: event.outcome })
        return
      }
      case 'question.request': {
        const first = event.request.questions[0]
        emitInto(fold, 'approval/asked', undefined, {
          id: event.request.requestId,
          toolName: 'question',
          ...(event.request.callId === undefined ? {} : { callId: event.request.callId }),
          ...(first === undefined ? {} : { reason: first.question }),
          // 问卷结构的有界快照（≤5 问 × ≤6 选项标签）；settled 只报
          // requestId，答案由检视器按 callId 配对工具结果时读取。
          ask: 'question',
          ...(event.request.agentId === undefined ? {} : { agentId: event.request.agentId }),
          ...(event.request.questions.length === 0
            ? {}
            : {
                questions: Object.freeze(
                  event.request.questions.slice(0, 5).map(question =>
                    Object.freeze({
                      ...(question.header === undefined ? {} : { header: question.header }),
                      question: question.question,
                      options: freezeLabels(question.options.slice(0, 6).map(option => option.label)),
                    }),
                  ),
                ),
              }),
        })
        return
      }
      case 'question.settled': {
        emitInto(fold, 'approval/decided', undefined, { id: event.requestId, outcome: 'settled' })
        return
      }
      case 'compaction.start': {
        emitInto(fold, 'compaction/start', event.time, { reason: event.trigger })
        return
      }
      case 'compaction.end': {
        const removed = event.preTokens !== undefined && event.postTokens !== undefined
          ? Math.max(0, event.preTokens - event.postTokens)
          : undefined
        emitInto(fold, 'compaction/end', event.time, {
          ...(removed === undefined ? {} : { removed }),
          ...(event.error === undefined ? {} : { reason: event.error }),
        })
        return
      }
      case 'subagent.start': {
        // Registration precedes the row so the lane exists for the traffic
        // that follows; the descriptor itself is a MAIN-lane presence row
        // carrying the agentId the drilldown anchors to.
        registerLane(event)
        emitInto(main, 'subagent/descriptor', event.time, {
          ...(event.description === '' ? {} : { label: event.description }),
          ...(event.model === undefined ? {} : { agentModel: event.model }),
          agentId: event.agentId,
        })
        return
      }
      case 'subagent.progress':
      case 'subagent.end': {
        // Progress churn belongs to the agents panel; the child's usage
        // stays OUT of the parent's token totals (the fold would double
        // count a cost the child's own surfaces already report).
        return
      }
      case 'user.message': {
        if (duplicate(fold, 'user.message', event.seq)) return
        if (event.text.trim() === '') return
        emitInto(fold, 'user/message', event.time, {
          source: { kind: event.source, ...(event.label === undefined ? {} : { name: event.label }) },
          content: [{ type: 'text', text: event.text }],
        })
        return
      }
      case 'todo.write': {
        emitInto(fold, 'todo/write', undefined, { todos: event.items })
        return
      }
      case 'notice': {
        // The one notice the mapping table claims: the backend's api-retry
        // toast is the only retry signal a Claude stream offers.
        if (event.key === 'api-retry') { closeRetry(fold); noteRetry(fold, event.text) }
        return
      }
      default:
        return
    }
  }

  const observe = (event: AgentEvent, _replaying: boolean): void => {
    // Child-lane traffic (a subagent's own assistant/tool stream) folds into
    // that agent's OWN lane log — the delegating tool bracket already spans
    // it in the parent's ledger. The vocabulary attributes a lane ONLY
    // through `parentCallId`; an event whose anchor call never registered a
    // lane stays skipped exactly as before. Every other kind — including
    // subagent lifecycle, permissions and questions, which carry no lane
    // attribution — folds into the main lane.
    switch (event.type) {
      case 'assistant.delta':
      case 'assistant.message':
      case 'assistant.attempt.start':
      case 'tool.call':
      case 'tool.result':
      case 'tool.progress': {
        if (event.parentCallId !== undefined) {
          const owner = laneByCall.get(event.parentCallId)
          const lane = owner === undefined ? undefined : lanes.get(owner)
          if (lane === undefined) return
          foldEvent(lane.fold, event)
          return
        }
        foldEvent(main, event)
        return
      }
      default:
        foldEvent(main, event)
    }
  }

  /** A lane snapshot: lazily frozen copy of the current fold. */
  const foldSnapshot = (fold: LaneFold): readonly RawTrajEvent[] => {
    fold.snapshot ??= Object.freeze([...fold.emitted])
    return fold.snapshot
  }

  /** Resolve a lane id through re-key aliases to its current record. */
  const laneRecord = (agentId: string): LaneRecord | undefined => {
    let id = agentId
    for (let hop = 0; hop < 8; hop++) {
      const record = lanes.get(id)
      if (record !== undefined) return record
      const next = laneAlias.get(id)
      if (next === undefined) return undefined
      id = next
    }
    return undefined
  }

  return {
    observe,
    reset(): void {
      main = newFold(undefined)
      lanes.clear()
      laneByCall.clear()
      callLane.clear()
      laneAlias.clear()
      laneVersion = 0
      mergedCache = undefined
      seq = 0
    },
    events: (): readonly RawTrajEvent[] => foldSnapshot(main),
    lanes: (): readonly TrajectoryLane[] =>
      Array.from(lanes.values(), record =>
        Object.freeze({
          agentId: record.agentId,
          ...(record.callId === undefined ? {} : { callId: record.callId }),
          ...(record.label === undefined ? {} : { label: record.label }),
          ...(record.model === undefined ? {} : { model: record.model }),
          ...(record.parentAgentId === undefined ? {} : { parentAgentId: record.parentAgentId }),
          depth: record.depth,
        })),
    laneEvents: (agentId: string): readonly RawTrajEvent[] => {
      const record = laneRecord(agentId)
      return record === undefined ? Object.freeze([]) : foldSnapshot(record.fold)
    },
    descendantEvents: (agentId: string): readonly RawTrajEvent[] => {
      const root = laneRecord(agentId)
      if (root === undefined) return Object.freeze([])
      if (mergedCache !== undefined && mergedCache.agentId === root.agentId && mergedCache.version === laneVersion) {
        return mergedCache.snapshot
      }
      // Subtree by parentAgentId edges, then a seq merge (each lane's log is
      // seq-sorted; the merged result must be too for the inspector's search).
      const ids = [root.agentId]
      const members: LaneFold[] = [root.fold]
      for (let index = 0; index < ids.length; index++) {
        for (const [candidateId, record] of lanes) {
          if (record.parentAgentId === ids[index] && !ids.includes(candidateId)) {
            ids.push(candidateId)
            members.push(record.fold)
          }
        }
      }
      const merged: RawTrajEvent[] = []
      for (const fold of members) merged.push(...fold.emitted)
      merged.sort((a, b) => a.seq - b.seq)
      const snapshot = Object.freeze(merged)
      mergedCache = { agentId: root.agentId, version: laneVersion, snapshot }
      return snapshot
    },
  }
}
