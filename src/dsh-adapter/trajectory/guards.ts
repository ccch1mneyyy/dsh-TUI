/**
 * Structural guards for the session events the trajectory projection reads.
 *
 * ## Why guards instead of the declared types
 *
 * `SessionEventMap` declares a dozen-odd core event types. Everything else in
 * the `KNOWN_SESSION_EVENT_TYPES` vocabulary arrives through *module
 * augmentation* from the plugin that owns it — `llm/retry` from the LLM
 * layer, `hook/*` from the hook runner, `tool/code-dispatch*` (pre-0.1.5) /
 * `tool/ptc-dispatch*` (0.1.5) from the code/PTC runtime. Those declaration
 * packages are not all in this bundle's dependency
 * graph, so `event.type === 'llm/retry'` does not even type-check here: the
 * literal is not a member of the union TypeScript can see.
 *
 * The answer is the one the adapter boundary already prescribes for upstream
 * coupling — widen once, at a single auditable point ({@link asRawEvents}),
 * then validate shapes at runtime. Every guard below is a *total function*:
 * a payload that does not match returns `undefined` and the fold skips that
 * event. An upstream release that renames a field degrades the trajectory by
 * one row kind; it never throws inside a render.
 *
 * ## Why these exact shapes
 *
 * Each guard was written against payloads decoded out of real session logs
 * (39 sessions, 96,836 events) rather than from documentation, and the
 * corresponding fixture in `verify-trace-projection.mjs` reproduces the same
 * shape. Where a field was absent from every observed sample it is optional
 * here, so a future harness that starts emitting it is picked up for free.
 */

import * as dshLlm from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, TimedStreamChunk } from '@deepseek-ai/dsh-llm'

import type { RawTrajEvent } from '../../adapter/ports/channel-view.js'
export type { RawTrajEvent } from '../../adapter/ports/channel-view.js'

/**
 * A session event reduced to the envelope the projection relies on. Only
 * `type`, `seq` and `time` are contractual across every event; `data` is
 * deliberately `unknown` so nothing downstream can read it without a guard.
 */


/**
 * The single widening point for the whole trajectory feature.
 *
 * `SessionEvent`'s `type` is a union of the *locally declared* event names;
 * the projection must also reason about augmented names it cannot see in the
 * type graph. Widening the array element to {@link RawTrajEvent} keeps every
 * field the projection reads (envelope) while forcing `data` through the
 * guards below. The cast is structural-only — no property is added, removed,
 * or reinterpreted — and it is the one place a reviewer must check.
 *
 * @param events - The session's immutable event snapshot.
 * @returns The same array, typed for guard-mediated access.
 */
export function asRawEvents(events: readonly RawTrajEvent[]): readonly RawTrajEvent[] {
  return events as readonly RawTrajEvent[]
}

/** True for a non-null object — the precondition of every guard below. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read a string property, or `undefined` when absent or the wrong type. */
function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/** Read a finite number property, or `undefined` when absent or non-finite. */
function num(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * An `llm/retry` payload.
 *
 * Observed shape: `{ retryId, turn, step, provider, mode, policyKey, retry,
 * maxRetries, delayMs, failure: { message, code } }`. `retryId` pairs the
 * event with the `llm/retry-started` that follows; `failure.code` is the
 * classifier (`RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` /
 * `EMPTY_RESPONSE`) shown as the row's error identity.
 */
export interface RetryPayload {
  readonly retryId: string
  readonly turn?: number
  readonly step?: number
  /** Provider whose request failed — shown as an inspector fact. */
  readonly provider?: string
  readonly retry: number
  readonly maxRetries?: number
  readonly delayMs: number
  readonly code?: string
  readonly message?: string
}

/** Narrow an `llm/retry` payload; `undefined` when the shape does not match. */
export function readRetry(data: unknown): RetryPayload | undefined {
  if (!isRecord(data)) return undefined
  const retryId = str(data, 'retryId')
  const retry = num(data, 'retry')
  const delayMs = num(data, 'delayMs')
  if (retryId === undefined || retry === undefined || delayMs === undefined) return undefined
  const failure = isRecord(data.failure) ? data.failure : undefined
  return {
    retryId,
    turn: num(data, 'turn'),
    step: num(data, 'step'),
    provider: str(data, 'provider'),
    retry,
    maxRetries: num(data, 'maxRetries'),
    delayMs,
    code: failure === undefined ? undefined : str(failure, 'code'),
    message: failure === undefined ? undefined : str(failure, 'message'),
  }
}

/** The `retryId` of an `llm/retry-started`, used to close the retry bracket. */
export function readRetryStarted(data: unknown): string | undefined {
  return isRecord(data) ? str(data, 'retryId') : undefined
}

/**
 * A `tool/code-dispatch*` / `tool/ptc-dispatch*` payload — the code runner's
 * nested tool calls, and the only source of SUBTOOL rows.
 *
 * The dispatch bracket was renamed with the runtime: pre-0.1.5 logs carry
 * `tool/code-dispatch-start` ↔ `tool/code-dispatch`, 0.1.5 logs carry
 * `tool/ptc-dispatch-start` ↔ `tool/ptc-dispatch`, paired by `subCallId` in
 * both generations; `rootCallId`/`parentCallId` give the enclosing
 * model-issued call. The payload shape is identical across the rename, so
 * this one guard serves both. `subCallId` is treated as an OPAQUE pairing
 * key: the fold never parses the `<parent>:code:<n>` / `<parent>:ptc:<n>`
 * infix, so a renamed (or future) id scheme cannot break pairing.
 * `arguments` is a structured value here (unlike `tool/call`, whose
 * `arguments` is the model's raw JSON string), so it is stringified for the
 * preview at guard time — the payload object is small and already
 * materialized by the log reader.
 */
export interface DispatchPayload {
  readonly subCallId: string
  readonly rootCallId?: string
  readonly parentCallId?: string
  readonly name: string
  readonly args?: string
  readonly isError?: boolean
}

/** Narrow a `tool/code-dispatch*` / `tool/ptc-dispatch*` payload. */
export function readDispatch(data: unknown): DispatchPayload | undefined {
  if (!isRecord(data)) return undefined
  const subCallId = str(data, 'subCallId')
  const name = str(data, 'name')
  if (subCallId === undefined || name === undefined) return undefined
  const rawArgs = data.arguments
  let args: string | undefined
  if (typeof rawArgs === 'string') args = rawArgs
  else if (rawArgs !== undefined) {
    // Structured arguments: a bounded stringify. JSON.stringify throws on
    // circular references, which a JSON-validated log cannot contain — but
    // the guard contract is "never throw", so it is caught regardless.
    try {
      args = JSON.stringify(rawArgs)
    } catch {
      args = undefined
    }
  }
  const isError = data.isError
  return {
    subCallId,
    rootCallId: str(data, 'rootCallId'),
    parentCallId: str(data, 'parentCallId'),
    name,
    args,
    isError: typeof isError === 'boolean' ? isError : undefined,
  }
}

/**
 * Expand the compact `stream` of a V3 `assistant/message` / `assistant/attempt`
 * into timed chunks, or `undefined` when the event carries no usable stream.
 *
 * V3 logs replace per-token `assistant/chunk` events with one compact
 * `AssistantStreamRecord[]` embedded in the settlement event. Upstream's
 * `expandAssistantStream` is the validating read path for that record list —
 * and it landed with the record type itself (0.1.5), so the binding is
 * feature-detected through the namespace rather than named-imported: a
 * pre-0.1.5 host lacks the export, and a named import would fail the whole
 * module at link time instead of degrading this one read. The same
 * never-throw contract as every guard here applies on both axes: a missing
 * expander or a malformed record (the expander throws `TypeError`) yields
 * `undefined`, and the fold simply contributes no stream timing.
 */
export function readAssistantStream(data: unknown): readonly TimedStreamChunk[] | undefined {
  if (!isRecord(data)) return undefined
  const stream = data.stream
  if (!Array.isArray(stream) || stream.length === 0) return undefined
  const expand = (dshLlm as Record<string, unknown>).expandAssistantStream
  if (typeof expand !== 'function') return undefined
  try {
    return (expand as (records: readonly AssistantStreamRecord[]) => readonly TimedStreamChunk[])(stream)
  } catch {
    return undefined
  }
}

/**
 * A `request/header` payload, reduced to the route facts the trajectory
 * shows: which model actually served this request, at which effort. The full
 * header (system prompt, tool catalog) stays in the log for the inspector.
 */
export interface RequestHeaderPayload {
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly reason?: string
}

/** Narrow a `request/header` payload. */
export function readRequestHeader(data: unknown): RequestHeaderPayload | undefined {
  if (!isRecord(data)) return undefined
  const header = isRecord(data.header) ? data.header : undefined
  if (header === undefined) return undefined
  const config = isRecord(header.config) ? header.config : undefined
  return {
    provider: config === undefined ? undefined : str(config, 'provider'),
    model: config === undefined ? undefined : str(config, 'model'),
    effort: config === undefined ? undefined : str(config, 'reasoningEffort'),
    reason: str(data, 'reason'),
  }
}

/** A `subagent/descriptor` payload: what kind of child this session is. */
export interface SubagentPayload {
  readonly label?: string
  readonly model?: string
  readonly mode?: string
}

/** Narrow a `subagent/descriptor` payload. */
export function readSubagent(data: unknown): SubagentPayload | undefined {
  if (!isRecord(data)) return undefined
  return {
    label: str(data, 'label'),
    model: str(data, 'agentModel'),
    mode: str(data, 'mode'),
  }
}

/** An `approval/asked` payload. `id` pairs it with the `approval/decided`. */
export interface ApprovalAskedPayload {
  readonly id: string
  readonly toolName?: string
  readonly callId?: string
  readonly reason?: string
}

/** Narrow an `approval/asked` payload. */
export function readApprovalAsked(data: unknown): ApprovalAskedPayload | undefined {
  if (!isRecord(data)) return undefined
  const id = str(data, 'id')
  if (id === undefined) return undefined
  return {
    id,
    toolName: str(data, 'toolName'),
    callId: str(data, 'callId'),
    reason: str(data, 'reason'),
  }
}

/**
 * An `approval/decided` payload. `outcome` is a union upstream; it is read as
 * a plain string here and only compared against the denial spellings, so a
 * new outcome name degrades to "not a denial" rather than to a crash.
 */
export interface ApprovalDecidedPayload {
  readonly id: string
  readonly outcome: string
}

/** Narrow an `approval/decided` payload. */
export function readApprovalDecided(data: unknown): ApprovalDecidedPayload | undefined {
  if (!isRecord(data)) return undefined
  const id = str(data, 'id')
  if (id === undefined) return undefined
  const raw = data.outcome
  const outcome =
    typeof raw === 'string'
      ? raw
      : isRecord(raw)
        ? (str(raw, 'kind') ?? str(raw, 'decision') ?? '')
        : ''
  return { id, outcome }
}

/** Outcomes that mark an approval row as failed. */
const DENIED = new Set(['denied', 'deny', 'rejected', 'cancelled', 'canceled', 'unavailable'])

/** True when an approval outcome should render as an error. */
export function isApprovalDenied(outcome: string): boolean {
  return DENIED.has(outcome.toLowerCase())
}

/** A `hook/invoked` payload. */
export interface HookPayload {
  readonly id?: string
  readonly name: string
  readonly event?: string
}

/**
 * Narrow a `hook/invoked` / `hook/result` payload. No sample appeared in the
 * surveyed logs (no hooks were configured), so the accepted key spellings are
 * deliberately broad: any of `name`/`hook`/`hookName` identifies the hook.
 */
export function readHook(data: unknown): HookPayload | undefined {
  if (!isRecord(data)) return undefined
  const name = str(data, 'name') ?? str(data, 'hook') ?? str(data, 'hookName')
  if (name === undefined) return undefined
  return { id: str(data, 'id') ?? str(data, 'invocationId'), name, event: str(data, 'event') }
}

/** A `sandbox/mode`, `plan/mode`, `approval/policy` or `permission/preset` value. */
export function readModeValue(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  return str(data, 'mode') ?? str(data, 'policy') ?? str(data, 'preset') ?? str(data, 'name')
}

/** A `command/run` payload — the slash command the user dispatched. */
export function readCommandRun(data: unknown): { name: string; args?: string } | undefined {
  if (!isRecord(data)) return undefined
  const name = str(data, 'name')
  if (name === undefined) return undefined
  return { name, args: str(data, 'args') }
}

/** A `compaction/*` payload; every field is optional across the bracket. */
export interface CompactionPayload {
  readonly id?: string
  readonly reason?: string
  readonly removed?: number
}

/** Narrow a `compaction/start` or `compaction/end` payload. */
export function readCompaction(data: unknown): CompactionPayload {
  if (!isRecord(data)) return {}
  return {
    id: str(data, 'id') ?? str(data, 'compactionId'),
    reason: str(data, 'reason') ?? str(data, 'trigger'),
    removed: num(data, 'removed') ?? num(data, 'pruned'),
  }
}

/** A `todo/write` payload, reduced to the progress counters. */
export function readTodos(data: unknown): { done: number; total: number; current?: string } | undefined {
  if (!isRecord(data)) return undefined
  const todos = data.todos
  if (!Array.isArray(todos)) return undefined
  let done = 0
  let current: string | undefined
  for (const item of todos) {
    if (!isRecord(item)) continue
    const status = str(item, 'status')
    if (status === 'completed') done += 1
    else if (status === 'in_progress' && current === undefined) current = str(item, 'content')
  }
  return { done, total: todos.length, current }
}
