/**
 * Test-only lifecycle gate for the neutral event stream. Session facts (mode,
 * capacity, notices, background lanes) need no foreground turn. Positioned
 * foreground facts do; late usage may refer to an already closed turn.
 * A settled message closes its attempt, a superseding start abandons it, and
 * a non-completed turn end aborts it. turn.end also retires unfinished tools.
 * These are the production projector's contracts, not backend-specific rules.
 */
import type { AgentEvent } from '../../src/agent/events.js'

export interface AgentEventInvariantOptions {
  /** A fixture stopped mid-turn (including a replay's last in-progress turn). */
  readonly allowOpenLastTurn?: boolean
  /** Local submissions need not emit a queue snapshot (Claude's previews are
   * channel-owned). Record their admission before the next translated event. */
  readonly enqueuedInputs?: readonly { readonly id: string; readonly beforeEvent: number }[]
}

export interface AgentEventInvariantViolation {
  readonly code: string
  readonly index: number
  readonly type: AgentEvent['type'] | 'end-of-stream'
  /** Metadata only: never message, tool, question or credential content. */
  readonly detail: string
}

type Attempt = { readonly id: string; readonly turn: number; readonly step: number; readonly lane?: string }
type Call = { readonly turn: number; readonly lane?: string; open: boolean; settled: boolean }

/** Inspect a complete stream; the default requires every foreground turn to close. */
export function agentEventInvariantViolations(events: readonly AgentEvent[], options: AgentEventInvariantOptions = {}): AgentEventInvariantViolation[] {
  const errors: AgentEventInvariantViolation[] = []
  const turns = new Set<number>()
  const attempts = new Map<string, Attempt>()
  const calls = new Map<string, Call>()
  const laneByAgent = new Map<string, string>()
  const permissions = new Map<string, number | undefined>()
  const questions = new Map<string, number | undefined>()
  const queued = new Set<string>()
  const admissions = new Map<number, string[]>()
  for (const input of options.enqueuedInputs ?? []) {
    const ids = admissions.get(input.beforeEvent) ?? []
    ids.push(input.id)
    admissions.set(input.beforeEvent, ids)
  }
  let active: number | undefined
  let lastSeq: number | undefined
  const key = (lane: string | undefined, id: string): string => (lane ?? '') + ':' + id
  const closeAttempts = (matches: (attempt: Attempt) => boolean): void => {
    for (const [id, attempt] of attempts) if (matches(attempt)) attempts.delete(id)
  }
  const closeCalls = (matches: (call: Call) => boolean): void => {
    for (const call of calls.values()) if (matches(call)) call.open = false
  }

  events.forEach((event, index) => {
    for (const id of admissions.get(index) ?? []) queued.add(id)
    const fail = (code: string, detail: string): void => { errors.push({ code, index, type: event.type, detail }) }
    if ('seq' in event && event.seq !== undefined) {
      if (lastSeq !== undefined && event.seq <= lastSeq) fail('seq-order', 'seq ' + event.seq + ' follows ' + lastSeq)
      lastSeq = event.seq
    }
    const lane = 'parentCallId' in event ? event.parentCallId : undefined
    const checkpoint = event.type === 'user.message' && event.source === 'compaction'
    if ('turn' in event && event.turn !== undefined && lane === undefined && !checkpoint && event.type !== 'turn.start' && event.type !== 'turn.end') {
      if (event.type === 'usage') {
        if (!turns.has(event.turn)) fail('turn-before-start', 'usage turn ' + event.turn + ' never opened')
      } else if (active !== event.turn) {
        fail('turn-outside', 'turn ' + event.turn + ', active ' + String(active))
      }
    }
    switch (event.type) {
      case 'turn.start':
        if (active !== undefined) fail('turn-overlap', 'turn ' + event.turn + ' starts before ' + active + ' ends')
        if (turns.has(event.turn)) fail('turn-reused', 'turn ' + event.turn + ' starts twice')
        turns.add(event.turn)
        active = event.turn
        break
      case 'turn.end':
        if (active !== event.turn) fail('turn-end', 'turn ' + event.turn + ', active ' + String(active))
        for (const attempt of attempts.values()) {
          if (attempt.lane === undefined && attempt.turn === event.turn && event.reason.kind === 'completed') {
            fail('attempt-unclosed', 'attempt ' + attempt.id + ' at completed turn ' + event.turn)
          }
        }
        closeAttempts(attempt => attempt.lane === undefined && attempt.turn === event.turn)
        closeCalls(call => call.lane === undefined && call.turn === event.turn)
        active = undefined
        break
      case 'assistant.attempt.start':
        // The vocabulary defines a superseding start as abandoning the old
        // provisional attempt in the same lane (DSH retry / reattach).
        closeAttempts(attempt => attempt.lane === lane)
        attempts.set(key(lane, event.attemptId), { id: event.attemptId, turn: event.turn, step: event.step, ...(lane === undefined ? {} : { lane }) })
        break
      case 'assistant.message':
        closeAttempts(attempt => attempt.lane === lane && (attempt.id === event.attemptId || (attempt.turn === event.turn && attempt.step === event.step)))
        break
      case 'assistant.attempt.end':
        // A positioned durable end may have no streamed start (DSH replay);
        // an unpositioned end after a message is also a legal explicit close.
        closeAttempts(attempt => attempt.lane === lane && (attempt.id === event.attemptId || (event.turn !== undefined && attempt.turn === event.turn && attempt.step === event.step)))
        break
      case 'assistant.delta':
        if (lane === undefined && event.turn === undefined && active === undefined) fail('turn-outside', 'unpositioned foreground delta has no open turn')
        break
      case 'tool.call': {
        const id = key(lane, event.callId)
        if (calls.has(id)) fail('tool-duplicate', 'call ' + event.callId + ' repeated')
        calls.set(id, { turn: event.turn, ...(lane === undefined ? {} : { lane }), open: true, settled: false })
        break
      }
      case 'tool.result': {
        const call = calls.get(key(lane, event.callId))
        if (call === undefined) fail('tool-orphan', 'result ' + event.callId + ' has no call')
        else {
          if (call.settled) fail('tool-duplicate', 'result ' + event.callId + ' repeated')
          if (call.turn !== event.turn) fail('tool-turn', 'result ' + event.callId + ' changed turn')
          call.open = false
          call.settled = true
        }
        break
      }
      case 'subagent.start':
        if (event.parentCallId !== undefined) laneByAgent.set(event.agentId, event.parentCallId)
        break
      case 'subagent.end': {
        const child = laneByAgent.get(event.agentId)
        if (child !== undefined) {
          closeCalls(call => call.lane === child)
          closeAttempts(attempt => attempt.lane === child)
        }
        break
      }
      case 'permission.request':
      case 'question.request': {
        const requests = event.type === 'permission.request' ? permissions : questions
        if (requests.has(event.request.requestId)) fail('request-duplicate', 'request ' + event.request.requestId + ' repeated')
        requests.set(event.request.requestId, active)
        break
      }
      case 'permission.settled':
      case 'question.settled': {
        const requests = event.type === 'permission.settled' ? permissions : questions
        if (!requests.delete(event.requestId)) fail('request-orphan', 'settlement ' + event.requestId + ' has no request')
        break
      }
      case 'pending.changed':
        for (const id of event.claimed ?? []) if (!queued.has(id)) fail('pending-unseen', 'claimed ' + id + ' was never enqueued')
        for (const item of event.items) queued.add(item.id)
        break
      case 'session.reset':
        if (active !== undefined) fail('turn-reset', 'reset precedes turn ' + active + ' end')
        break
      default:
        break
    }
  })
  const end = (code: string, detail: string): void => { errors.push({ code, index: events.length, type: 'end-of-stream', detail }) }
  const allowedTail = (turn: number | undefined): boolean => options.allowOpenLastTurn === true && active !== undefined && turn === active
  if (active !== undefined && !allowedTail(active)) end('turn-unclosed', 'turn ' + active + ' never ended')
  for (const attempt of attempts.values()) if (!allowedTail(attempt.turn)) end('attempt-unclosed', 'attempt ' + attempt.id + ' never closed')
  for (const [id, call] of calls) if (call.open && !allowedTail(call.turn)) end('tool-unclosed', 'call ' + id + ' never settled or retired')
  for (const [id, turn] of permissions) if (!allowedTail(turn)) end('request-unclosed', 'permission ' + id + ' never settled')
  for (const [id, turn] of questions) if (!allowedTail(turn)) end('request-unclosed', 'question ' + id + ' never settled')
  return errors
}

/** Assert with metadata-only diagnostics, safe for fixture and CI output. */
export function assertAgentEventInvariants(events: readonly AgentEvent[], options?: AgentEventInvariantOptions): void {
  const errors = agentEventInvariantViolations(events, options)
  if (errors.length > 0) throw new Error(errors.map(error => error.code + ' @' + error.index + ' ' + error.type + ': ' + error.detail).join('\n'))
}
