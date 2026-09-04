/**
 * Live Session compatibility facade.
 *
 * rc.2 / alpha.3 expose `Session.events` and header `seedLength`. alpha.4
 * deletes `events` in favour of `snapshotEvents` / `eventAt` / exclusive
 * `seq`, and moves fork lineage from header `seedLength` onto `isSeeded` plus
 * `Session.inheritedEventCount`. Feature detection stays here; callers must
 * not probe the two shapes themselves.
 *
 * `ctx.sessions.fork()` is not a seed extractor: it creates and registers a
 * real child. A child snapshot MAY include child-owned `session/end-seed`,
 * so snapshot length cannot reliably be inferred as the inherited cut.
 * Seed copies are sliced from the *source* snapshot through an inclusive
 * event seq. The cut is that source-slice length (or
 * `Session.inheritedEventCount` / physical `seedLength`), never a child
 * snapshot length.
 *
 * Physical JSONL still stores optional `seedLength`. That encoding belongs to
 * `sessionLog` / `sessions/header`, not this module.
 *
 * @module @deepseek-harness-tui/dsh-tui/compat/liveSession
 */
import * as dshSession from '@deepseek-ai/dsh-session'
import type { CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

interface LiveSessionShape {
  readonly seq?: unknown
  readonly events?: readonly SessionEvent[]
  readonly inheritedEventCount?: unknown
  readonly header?: Record<string, unknown>
  snapshotEvents?: (fromSeq?: unknown, toSeqExclusive?: unknown) => unknown
}

function liveOf(session: unknown): LiveSessionShape {
  if (session === null || typeof session !== 'object') {
    throw new Error('live Session contract violation: session is not an object')
  }
  return session as LiveSessionShape
}

function brandCtor(name: 'SessionSeq' | 'SessionLogOffset'): ((value: number) => number) | undefined {
  const ctor = (dshSession as Record<string, unknown>)[name]
  return typeof ctor === 'function' ? ctor as (value: number) => number : undefined
}

function brandSessionSeq(value: number): number {
  return brandCtor('SessionSeq')?.(value) ?? value
}

function brandSessionLogOffset(value: number): number {
  return brandCtor('SessionLogOffset')?.(value) ?? value
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
    ? value
    : undefined
}

/**
 * Snapshot of a live Session log, including any fork-inherited prefix.
 * Reuses upstream's frozen cache when the log has not appended.
 * A missing or non-array snapshot is a live Session contract violation.
 */
export function snapshotLiveSessionEvents(session: unknown): readonly SessionEvent[] {
  const live = liveOf(session)
  if (typeof live.snapshotEvents === 'function') {
    const snap = live.snapshotEvents()
    if (!Array.isArray(snap)) {
      throw new Error('live Session contract violation: snapshotEvents() did not return an array')
    }
    return snap as readonly SessionEvent[]
  }
  if (Array.isArray(live.events)) return live.events
  throw new Error('live Session contract violation: neither snapshotEvents() nor events is available')
}

/**
 * Exclusive log offset (`seq = log.length`). Empty log is 0, not -1, and this
 * is not the last event's seq.
 */
export function liveSessionOffset(session: unknown): number {
  const seq = asNonNegativeInt(liveOf(session).seq)
  if (seq !== undefined) return seq
  return snapshotLiveSessionEvents(session).length
}

function usesIsSeeded(session: unknown): boolean {
  return typeof liveOf(session).header?.['isSeeded'] === 'boolean'
}

/**
 * Physical/wire `seedLength` for a live Session: present whenever an exact
 * copied/inherited prefix is marked as seeded, independently of whether the
 * header records `parentSession`. Fresh unseeded sessions omit it.
 * `isSeeded: true` without `inheritedEventCount` is an unknown cut — never
 * coerced to 0.
 */
export function liveSessionPhysicalSeedLength(session: unknown): number | undefined {
  const live = liveOf(session)
  const header = live.header
  if (header !== undefined && typeof header['isSeeded'] === 'boolean') {
    if (header['isSeeded'] !== true) return undefined
    return asNonNegativeInt(live.inheritedEventCount)
  }
  return asNonNegativeInt(header?.['seedLength'])
}

/** Listing-shaped fields for overlaying a live Session onto the session tree. */
export function liveSessionListingFields(session: unknown): {
  readonly id: string | undefined
  readonly cwd: string | undefined
  readonly createdAt: number | undefined
  readonly parentSession: string | undefined
  readonly origin: string | undefined
  readonly delegationDepth: number | undefined
  readonly agentPreset: string | undefined
  readonly seedLength: number | undefined
} {
  const header = liveOf(session).header ?? {}
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined
  return {
    id: text(header['id']),
    cwd: text(header['cwd']),
    createdAt: asNonNegativeInt(header['createdAt']),
    parentSession: text(header['parentSession']),
    origin: text(header['origin']),
    delegationDepth: asNonNegativeInt(header['delegationDepth']),
    agentPreset: text(header['agentPreset']),
    seedLength: liveSessionPhysicalSeedLength(session),
  }
}

function assertTurnClosed(sliced: readonly SessionEvent[], boundaryLabel: string): void {
  const lastTurn = sliced.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (lastTurn?.type === 'turn/start') {
    throw new Error(`fork boundary ${boundaryLabel} ends inside open turn ${String(lastTurn.data.turn)}`)
  }
}

/**
 * Copy of the source log through an inclusive event seq. Omitted boundary
 * means the whole log and still rejects an open turn. Never calls
 * `sessions.fork()`.
 */
export function sliceLiveSessionSeed(session: unknown, boundary?: number): SessionEvent[] {
  const events = snapshotLiveSessionEvents(session)
  const offset = liveSessionOffset(session)
  if (events.length !== offset) {
    throw new Error(
      `live Session contract violation: snapshot length ${events.length} does not match exclusive seq ${offset}`,
    )
  }
  if (boundary === undefined) {
    const sliced = [...events]
    if (sliced.length === 0) return sliced
    assertTurnClosed(sliced, String(offset - 1))
    return sliced
  }
  if (!Number.isSafeInteger(boundary) || boundary < 0 || Object.is(boundary, -0)) {
    throw new Error(`fork boundary must be a non-negative safe integer, got ${String(boundary)}`)
  }
  if (boundary >= offset) {
    const lastSeq = offset === 0 ? 'none' : String(offset - 1)
    throw new Error(`fork boundary ${boundary} does not exist (last seq: ${lastSeq})`)
  }
  const boundaryEvent = events[boundary]
  if (boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
    throw new Error(`fork boundary ${boundary} does not match a contiguous event seq`)
  }
  const sliced = events.slice(0, boundary + 1)
  assertTurnClosed(sliced, String(boundary))
  return sliced
}

export interface LiveSessionSeedMetadata {
  readonly meta: {
    readonly seedLength?: number
    readonly isSeeded?: boolean
  }
  readonly inheritedEventCount?: number
}

/**
 * Create-time seed ownership fields. Every copied source prefix is inherited
 * state for domain projections, even when `/fork` deliberately omits
 * `parentSession` so the copy is presented as an independent root. The exact
 * cut prevents schedule/inbox/subagent projections from replaying copied
 * history as child-owned events. A child snapshot length cannot reliably be
 * used as that cut because construction may append `session/end-seed`.
 */
export function liveSessionSeedMetadata(
  session: unknown,
  inheritedCount: number,
): LiveSessionSeedMetadata {
  if (usesIsSeeded(session)) {
    return {
      meta: { isSeeded: true },
      inheritedEventCount: brandSessionLogOffset(inheritedCount),
    }
  }
  return { meta: { seedLength: inheritedCount } }
}

/** Close an open turn with the `turn/end` shape a real user cancellation writes. */
export function appendInterruptedTurnEnd(seed: SessionEvent[], turn: number): void {
  const last = seed[seed.length - 1]
  if (last === undefined) return
  seed.push({
    type: 'turn/end',
    seq: brandSessionSeq(Number(last.seq) + 1),
    time: last.time + 1,
    data: { turn, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  } as SessionEvent)
}

export interface LiveSessionCreateRequest {
  readonly sessionId: SessionId
  readonly seed: readonly SessionEvent[]
  /** Live Session whose shape identifies the active upstream runtime line. */
  readonly runtimeSession: unknown
  readonly inheritedCount: number
  readonly cwd: string
  readonly parentSession?: SessionId
  readonly agentPreset?: string
  readonly agentOptions: CreateAgentOptions['agentOptions']
  readonly setup?: CreateAgentOptions['setup']
}

/**
 * Dual-runtime seed metadata for `agents.create`. The only
 * CreateAgentOptions assertion lives here: rc.2 meta carries `seedLength`,
 * alpha.4 carries `isSeeded` plus top-level `inheritedEventCount`.
 */
export function liveSessionCreateOptions(request: LiveSessionCreateRequest): CreateAgentOptions {
  const seedMetadata = liveSessionSeedMetadata(request.runtimeSession, request.inheritedCount)
  return {
    sessionId: request.sessionId,
    seed: request.seed,
    meta: {
      cwd: request.cwd,
      ...(request.parentSession === undefined ? {} : { parentSession: request.parentSession }),
      ...seedMetadata.meta,
      ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
    },
    ...(seedMetadata.inheritedEventCount === undefined
      ? {}
      : { inheritedEventCount: seedMetadata.inheritedEventCount }),
    agentOptions: request.agentOptions,
    ...(request.setup === undefined ? {} : { setup: request.setup }),
  } as CreateAgentOptions
}
