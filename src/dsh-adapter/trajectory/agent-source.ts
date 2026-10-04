/**
 * The backend-neutral trajectory source (design agent-team-panels.md §④
 * 轨迹裁决): an incremental fold of the shared AgentEvent vocabulary into
 * the raw-event envelope the trajectory projection already consumes.
 *
 * ## Why this exists
 *
 * `/trace` and the trajectory panel fold {@link RawTrajEvent}s — the DSH
 * session log's vocabulary — because that is what a DSH composition's raw
 * history natively is. A session without that log (Claude today) still
 * streams the SAME high-fidelity AgentEvents every backend translator
 * emits, so its trajectory is a translation problem, not a missing
 * capability: this module is the neutral source that mounts for any such
 * composition and keeps the three-state report honest ('empty' before the
 * first mapped event, 'supported' from then on — 'unsupported' stays the
 * structural declaration of a composition that mounted no source at all).
 *
 * ## The mapping table (design line-by-line)
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
 * | `permission.request`/`settled` | `approval/asked`/`approval/decided` | paired by `requestId`. |
 * | `question.request`/`settled` | `approval/asked`/`approval/decided` | the questionnaire as an approval-shaped bracket (MVP: no detail panel). |
 * | `compaction.start`/`end` | `compaction/start`/`compaction/end` | `removed` derived from pre/post tokens when both are known. |
 * | `subagent.start` | `subagent/descriptor` | the child lane's presence row; its own assistant/tool traffic is NOT folded (it belongs to the child's transcript — the delegating tool bracket already spans it), and subagent usage never enters the parent's token totals. |
 * | `user.message` | `user/message` | human prompts as user rows, injected/goal/compaction output as context rows. |
 * | `todo.write` | `todo/write` | parity with the DSH row. |
 *
 * ## Clocks, identity, immutability
 *
 * Events without a timestamp take the trace clock (`Date.now` at receipt)
 * and carry `data.observed = true` so the inspector can mark the row's time
 * as an observation rather than a backend fact. `seq` is this source's own
 * monotonic counter: durable `seq`s the vocabulary carries are used ONLY for
 * deduplication (a reconnect may replay a durable chunk), never as envelope
 * identity — the envelope must stay monotonic in emission order for the
 * inspector's binary search. Emitted events and their payloads are frozen
 * and the backing array only appends, so the projection's incremental
 * prefix-identity contract holds exactly as it does for a DSH snapshot.
 */

import type { AgentEvent } from '../../agent/events.js'
import type { RawTrajEvent } from './guards.js'

/** The neutral source a backend-neutral composition mounts. */
export interface AgentTrajectorySource {
  /** Fold one stream event (live or replayed) into the raw-event log. */
  observe(event: AgentEvent, replaying: boolean): void
  /** Forget everything: a session swap or an in-place conversation reset. */
  reset(): void
  /** The append-only raw-event snapshot (`traceEvents()`'s return). */
  events(): readonly RawTrajEvent[]
}

/** One streamed attempt whose reasoning estimate is still accumulating. */
interface OpenAttempt {
  readonly attemptId: string
  readonly turn: number
  readonly step: number
  /** Summed `reasoning-tokens` estimates of this attempt. */
  thinkEstimated: number
}

/**
 * Create the source. `clock` is injectable so regressions can pin the
 * observation timestamps; it defaults to `Date.now`.
 */
export function createAgentTrajectorySource(options?: { readonly clock?: () => number }): AgentTrajectorySource {
  const clock = options?.clock ?? (() => Date.now())
  const emitted: RawTrajEvent[] = []
  /**
   * The published snapshot. The master array is mutable for O(1) appends,
   * but a consumer (`extendTrajectory`) detects growth by comparing the
   * SNAPSHOT's length and last-element identity against the live array —
   * handing out the master itself would make the two lengths always equal
   * and the incremental fold would never see a tail. So the snapshot is
   * rebuilt lazily on the first read after an append (one copy per read
   * burst, exactly the contract a DSH session's per-append frozen array
   * offers) and its elements keep their identities across generations.
   */
  let snapshot: readonly RawTrajEvent[] | undefined = Object.freeze([])
  /** Envelope seq — monotonic in emission order, this source's own. */
  let seq = 0
  /** Durable identities already folded (`type#seq`); reconnect replays. */
  const seen = new Set<string>()
  let turn = 0
  let attempt: OpenAttempt | undefined
  /** Retry rows opened this turn, closed by the next attempt or turn end. */
  let openRetry: { readonly retryId: string; readonly attempts: number } | undefined
  let retryCount = 0
  /** A retry was already signaled since the current attempt opened: one
   * failure produces at most one row, whichever signal carried it (an
   * `api-retry` toast, a superseded attempt start, or an abandoned end). */
  let retrySignaled = false

  const emit = (type: string, time: number | undefined, data: Record<string, unknown>): void => {
    const observed = time === undefined || !Number.isFinite(time)
    seq += 1
    emitted.push(Object.freeze({
      type,
      seq,
      time: observed ? clock() : time,
      data: Object.freeze(observed ? { ...data, observed: true } : data),
    }))
    snapshot = undefined as never
  }

  /** True (and remembers) when a durable-seq event was already folded. */
  const duplicate = (kind: string, durable: number | undefined): boolean => {
    if (durable === undefined || !Number.isFinite(durable)) return false
    const key = `${kind}#${durable}`
    if (seen.has(key)) return true
    seen.add(key)
    return false
  }

  /** Close the turn's open retry bracket (`llm/retry-started`). */
  const closeRetry = (): void => {
    if (openRetry === undefined) return
    emit('llm/retry-started', undefined, { retryId: openRetry.retryId })
    openRetry = undefined
  }

  /** One retry signal: a superseded/abandoned attempt or an api-retry toast. */
  const noteRetry = (message: string | undefined): void => {
    retryCount += 1
    // One row per signal: each closes when the replacement attempt starts
    // (or the turn ends), so a twice-retried turn shows two honest rows
    // rather than one row claiming a backoff ladder the source never saw.
    const retryId = `retry:${turn}:${retryCount}`
    openRetry = { retryId, attempts: 1 }
    retrySignaled = true
    emit('llm/retry', undefined, {
      retryId,
      retry: retryCount,
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

  const observe = (event: AgentEvent, _replaying: boolean): void => {
    // Child-lane traffic (a subagent's own assistant/tool stream) belongs
    // to the child's transcript; the delegating tool bracket already spans
    // it in the parent's ledger. Subagent LIFECYCLE events carry
    // `parentCallId` too and are deliberately not skipped below.
    switch (event.type) {
      case 'turn.start': {
        // Turn numbers are monotonic within one binding (a conversation
        // reset or a session swap resets the whole fold), so a REPLAYED
        // turn start with a number already folded is a reconnect echo —
        // deduplicated like the durable-seq events, or every replayed
        // batch would grow a second bracket row.
        if (seen.has('turn-start#' + event.turn)) return
        seen.add('turn-start#' + event.turn)
        closeRetry()
        turn = event.turn
        emit('turn/start', event.time, { turn: event.turn })
        return
      }
      case 'turn.end': {
        closeRetry()
        // Turn-level usage is the CLOSE event's payload; the projection
        // backfills it onto the turn row only when no message of the turn
        // carried usage — the two levels are distinguished, never summed.
        const usage = usageOf(event.usage, undefined)
        emit('turn/end', event.time, {
          turn: event.turn,
          reason: event.reason,
          ...(usage === undefined ? {} : { usage }),
        })
        return
      }
      case 'step.start': {
        const key = 'step-start#' + event.turn + ':' + event.step
        if (seen.has(key)) return
        seen.add(key)
        emit('step/start', undefined, { turn: event.turn, step: event.step })
        return
      }
      case 'step.end': {
        emit('step/end', undefined, { turn: event.turn, step: event.step })
        return
      }
      case 'assistant.attempt.start': {
        // A supersede means the replaced attempt failed and will be
        // retried; the retry row is the honest trace of that failure —
        // unless the failure already announced itself (the api-retry toast).
        if (attempt !== undefined && attempt.attemptId !== event.attemptId && !retrySignaled) {
          closeRetry()
          noteRetry(undefined)
        }
        closeRetry()
        retrySignaled = false
        attempt = { attemptId: event.attemptId, turn: event.turn, step: event.step, thinkEstimated: 0 }
        return
      }
      case 'assistant.attempt.end': {
        if (attempt?.attemptId === event.attemptId) attempt = undefined
        if (event.outcome !== 'committed' && !retrySignaled) { closeRetry(); noteRetry(undefined) }
        return
      }
      case 'assistant.delta': {
        if (event.parentCallId !== undefined) return
        if (event.delta.kind === 'reasoning-tokens') {
          if (attempt !== undefined && attempt.attemptId === event.attemptId) {
            attempt.thinkEstimated += event.delta.estimated
          }
          return
        }
        if (event.delta.kind === 'other') return
        if (event.seq !== undefined) {
          if (duplicate('delta', event.seq)) return
        } else if (attempt === undefined || attempt.attemptId !== event.attemptId) {
          return
        }
        const position = event.turn !== undefined && event.step !== undefined
          ? { turn: event.turn, step: event.step }
          : attempt
        if (position === undefined) return
        // The projection reads nothing from a chunk's payload — only its
        // envelope time separates first-token from decode throughput.
        emit('assistant/chunk', event.time, { turn: position.turn, step: position.step })
        return
      }
      case 'assistant.message': {
        if (event.parentCallId !== undefined) return
        if (duplicate('assistant.message', event.seq)) return
        const mine = attempt?.attemptId === event.attemptId ? attempt : undefined
        if (mine !== undefined) attempt = undefined
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
        emit('assistant/message', event.time, {
          turn: position?.turn ?? turn,
          ...(position?.step === undefined ? {} : { step: position.step }),
          message: { content: blocks },
          ...(usage === undefined ? {} : { usage }),
        })
        return
      }
      case 'tool.call': {
        if (event.parentCallId !== undefined) return
        if (duplicate('tool.call', event.seq)) return
        emit('tool/call', event.time, {
          turn: event.turn,
          step: event.step,
          callId: event.callId,
          name: event.name,
          arguments: event.argsJson,
        })
        return
      }
      case 'tool.result': {
        if (event.parentCallId !== undefined) return
        if (duplicate('tool.result', event.seq)) return
        emit('tool/result', event.time, {
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
      case 'tool.progress': {
        // Consumed, no row: a running row is already live in the ledger
        // and the wave band; an elapsed echo would add one row per poll.
        return
      }
      case 'permission.request': {
        const request = event.request
        emit('approval/asked', undefined, {
          id: request.requestId,
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          ...(request.reason === undefined && request.title === undefined && request.displayName === undefined
            ? {}
            : { reason: request.reason ?? request.title ?? request.displayName }),
        })
        return
      }
      case 'permission.settled': {
        emit('approval/decided', undefined, { id: event.requestId, outcome: event.outcome })
        return
      }
      case 'question.request': {
        const first = event.request.questions[0]
        emit('approval/asked', undefined, {
          id: event.request.requestId,
          toolName: 'question',
          ...(event.request.callId === undefined ? {} : { callId: event.request.callId }),
          ...(first === undefined ? {} : { reason: first.question }),
        })
        return
      }
      case 'question.settled': {
        emit('approval/decided', undefined, { id: event.requestId, outcome: 'settled' })
        return
      }
      case 'compaction.start': {
        emit('compaction/start', event.time, { reason: event.trigger })
        return
      }
      case 'compaction.end': {
        const removed = event.preTokens !== undefined && event.postTokens !== undefined
          ? Math.max(0, event.preTokens - event.postTokens)
          : undefined
        emit('compaction/end', event.time, {
          ...(removed === undefined ? {} : { removed }),
          ...(event.error === undefined ? {} : { reason: event.error }),
        })
        return
      }
      case 'subagent.start': {
        emit('subagent/descriptor', event.time, {
          ...(event.description === '' ? {} : { label: event.description }),
          ...(event.model === undefined ? {} : { agentModel: event.model }),
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
        if (duplicate('user.message', event.seq)) return
        if (event.text.trim() === '') return
        emit('user/message', event.time, {
          source: { kind: event.source, ...(event.label === undefined ? {} : { name: event.label }) },
          content: [{ type: 'text', text: event.text }],
        })
        return
      }
      case 'todo.write': {
        emit('todo/write', undefined, { todos: event.items })
        return
      }
      case 'notice': {
        // The one notice the mapping table claims: the backend's api-retry
        // toast is the only retry signal a Claude stream offers.
        if (event.key === 'api-retry') { closeRetry(); noteRetry(event.text) }
        return
      }
      default:
        return
    }
  }

  return {
    observe,
    reset(): void {
      emitted.length = 0
      seen.clear()
      seq = 0
      turn = 0
      attempt = undefined
      openRetry = undefined
      retryCount = 0
      retrySignaled = false
      snapshot = Object.freeze([])
    },
    events: (): readonly RawTrajEvent[] => {
      snapshot ??= Object.freeze([...emitted])
      return snapshot
    },
  }
}
