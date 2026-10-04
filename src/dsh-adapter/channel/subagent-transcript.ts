/**
 * DSH child transcript source (docs/dsh-child-transcript.md): the DSH
 * implementation of the backend-neutral `SubagentControl.history` contract,
 * next to Claude's on-disk child lane. Reads one direct child's own durable
 * session log through the public persistence range API only
 * (`ctx.sessionPersistence.open(id, 'read')` + `SessionHandle.read(offset,
 * length)`) and translates the page through a throwaway DSH translator into
 * the shared leaf vocabulary. The deprecated Session snapshot-events API and
 * the raw session-log file readers are not used.
 *
 * Read shape (every step bounded and fenced):
 *  1. ownership: the parent-owned `subagents.listChildren(parentId)` roster
 *     must name the child; a UI-supplied id is never opened on its own;
 *  2. durability: when the agents registry still holds the child's exact
 *     live Session, the public `ctx.sessions.flush(session)` barrier runs
 *     first (no whenIdle wait, no Agent create/resume); a failed or timed-out
 *     flush falls back to whatever prefix is already persisted;
 *  3. windows: the child's own events are `[inheritedEventCount, total)`;
 *     the fork-inherited prefix is never paged (a seeded header without its
 *     exact cut fails closed). `total` comes from `stat().eventCount` when
 *     the host states it, else from bounded single-event tail probes of the
 *     public range reader (never an unbounded whole-log read + slice);
 *  4. translation: a fresh translator instance per call; only the leaf
 *     kinds (`assistant.message` / `tool.call` / `tool.result`) survive,
 *     each stamped with the child lane's `parentCallId`, so the shared
 *     fold/page/merge pipeline consumes them exactly like Claude's;
 *  5. fences: the binding capture (session + generation) is re-checked after
 *     every await; a parent that moved on discards the page. The handle is
 *     closed exactly once on every path.
 */
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentTranscriptPage, SubagentTranscriptWindow } from '../../agent/capabilities.js'
import type { AgentEvent, AgentEventOf } from '../../agent/events.js'
import { textOfBlocks } from '../../channel/projection.js'
import type { DshTranslator } from '../backend/translate.js'
import { toolErrorText } from './transcript.js'
import type { SubagentsServiceView } from './subagent-projection.js'

/**
 * One page window in source events. Claude pages by 400 SDK messages
 * (`SUBAGENT_TRANSCRIPT_PAGE`) and the shared "load older" chunk is
 * `TRANSCRIPT_OLDER_CHUNK = 400`, so DSH pages by 400 SessionEvents and the
 * neutral cursor stays one unit wide for both backends.
 */
export const CHILD_TRANSCRIPT_PAGE_EVENTS = 400

/** Span ceiling for the exponential probe (2^24 ≈ 16.7M events). */
const PROBE_SPAN_MAX = 2 ** 24
/**
 * Tail-probe budget when `stat()` states no `eventCount` (the pinned JSONL
 * backend does not): exponential-then-binary single-event probes locate the
 * log end. Every probe reads exactly one event; the count is capped so a
 * pathological log degrades to "unavailable" instead of scanning. The worst
 * log under the span ceiling takes 24 exponential hits, one miss and 24
 * bisection steps.
 */
const PROBE_LIMIT = 2 * Math.log2(PROBE_SPAN_MAX) + 1

/** The binding identity one read captures and re-checks after every await. */
export interface ChildTranscriptCapture {
  readonly sessionId: string
  readonly generation: number
  /** The bound session object, opaque here; the `isCurrent` fence compares
   *  identity (the caller's binding owns the real type). */
  readonly session: object
}

/** Structural slice of `ctx.sessionPersistence` the child transcript uses. */
export interface ChildPersistenceSource {
  /** Cheap metadata observation; `eventCount` optional by contract. */
  stat?(id: string, options?: { readonly signal?: AbortSignal }): Promise<{ readonly eventCount?: unknown } | undefined>
  open(id: string, access: 'read', options?: { readonly signal?: AbortSignal }): Promise<ChildPersistenceHandle>
}

/** The public read-only `SessionHandle` as this module reads it. */
export interface ChildPersistenceHandle {
  readonly id: unknown
  readonly header: {
    readonly version?: unknown
    readonly id?: unknown
    readonly parentSession?: unknown
    readonly isSeeded?: unknown
  }
  /** Exact fork-inherited prefix length stored with the log (0 unseeded). */
  readonly inheritedEventCount?: unknown
  read(offset?: number, length?: number, options?: { readonly signal?: AbortSignal }): Promise<{ readonly events: readonly SessionEvent[] }>
  close(): Promise<void>
}

/** Structural slice of `ctx.sessions` (dsh-session SessionStore). */
export interface ChildSessionsStore {
  flush(session: object): Promise<unknown>
}

export interface ChildTranscriptDeps {
  /** Current binding identity; undefined when the DSH binding is gone. */
  capture(): ChildTranscriptCapture | undefined
  /** False once the channel re/switched away from the captured binding. */
  isCurrent(capture: ChildTranscriptCapture): boolean
  /** The continuation service (parent-owned child catalog). */
  subagents(): SubagentsServiceView | undefined
  /** The persistence service, re-resolved per call (never cached stale). */
  persistence(): ChildPersistenceSource | undefined
  /** The live sessions store for the pre-read flush barrier; optional. */
  sessionsStore(): ChildSessionsStore | undefined
  /** Registry child lookup: the exact live Session when it is held. */
  lookupChild(id: string): { readonly session?: unknown } | undefined
  /** A throwaway translator per call: history must not touch the live
   *  translator's frame fence or open-call ledger (backend/session.ts's
   *  own `history()` rule). */
  createTranslator(): DshTranslator
  /** Aborted when the channel owner releases; cancels a page read. */
  readonly ownerSignal?: AbortSignal
}

const staleError = (): Error => new Error('dsh-tui: the channel binding changed before the child transcript was read')

const optionalCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/**
 * Locate the log end with bounded single-event probes of the public range
 * reader, never an unbounded whole-log read: an event at `offset` proves the
 * log is longer; exponential steps find an empty
 * offset, binary search closes on the exact end. `known` must be an offset
 * whose event exists (the inherited cut boundary was just verified).
 */
async function probeLogEnd(
  handle: ChildPersistenceHandle,
  known: number,
  guard: () => void,
  signal: AbortSignal | undefined,
): Promise<number> {
  const eventAt = async (offset: number): Promise<boolean> => {
    guard()
    signal?.throwIfAborted()
    const { events } = await handle.read(offset, 1, signal === undefined ? undefined : { signal })
    return events.length > 0
  }
  let probes = 0
  const step = async (offset: number): Promise<boolean> => {
    if (probes >= PROBE_LIMIT) throw new Error('dsh-tui: the child transcript log exceeds the bounded tail-probe budget')
    probes += 1
    return eventAt(offset)
  }
  let present = known
  let span = 1
  let absent: number | undefined
  while (absent === undefined) {
    const candidate = present + span
    if (await step(candidate)) {
      present = candidate
      span *= 2
      if (span > PROBE_SPAN_MAX) throw new Error('dsh-tui: the child transcript log exceeds the bounded tail-probe budget')
      continue
    }
    absent = candidate
  }
  while (absent - present > 1) {
    const middle = Math.floor((present + absent) / 2)
    if (await step(middle)) present = middle
    else absent = middle
  }
  return absent
}

/**
 * Read one child transcript page: the newest window, or the
 * `window`-addressed older slice, of the child's own durable events. Null =
 * the parent's catalog holds no such direct child; a rejection = the read
 * failed (the transcript view shows "unavailable", never a fabricated empty
 * page).
 */
export async function readChildTranscriptPage(
  deps: ChildTranscriptDeps,
  agentId: string,
  window?: SubagentTranscriptWindow,
): Promise<SubagentTranscriptPage | null> {
  const capture = deps.capture()
  if (capture === undefined) throw new Error('dsh-tui: the bound session is not a DSH session')
  const guard = (): void => {
    if (!deps.isCurrent(capture)) throw staleError()
  }
  const signal = deps.ownerSignal
  signal?.throwIfAborted()

  const service = deps.subagents()
  if (service?.listChildren === undefined) throw new Error('dsh-tui: the subagents continuation service is unavailable')
  const persistence = deps.persistence()
  if (persistence === undefined) throw new Error('dsh-tui: session persistence is unavailable')

  // 1. ownership: only a child this parent's own catalog names is opened.
  const roster = await service.listChildren(capture.sessionId, signal)
  guard()
  if (!Array.from(roster ?? []).some(entry => entry?.id === agentId)) return null

  // 2. durability barrier for a still-live child (best effort; when it fails
  //    the read below sees whatever prefix is already persisted).
  try {
    const live = deps.lookupChild(agentId)?.session
    const flush = live === undefined || live === null ? undefined : deps.sessionsStore()?.flush(live as object)
    if (flush !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const completed = await Promise.race([
        flush.then(() => true, () => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2_000) }),
      ])
      if (!completed) process.stderr.write('dsh-tui: child transcript flush timed out after 2000ms\n')
      if (timer !== undefined) clearTimeout(timer)
    }
  } catch { /* best effort: the read below returns what is on disk */ }
  guard()

  // 3. cheap length when the host states it; otherwise bounded tail probes.
  let statCount: number | undefined
  try {
    statCount = optionalCount((await persistence.stat?.(agentId, signal === undefined ? undefined : { signal }))?.eventCount)
  } catch { /* stat is an optimization: open/read report the real failures */ }
  guard()

  const handle = await persistence.open(agentId, 'read', signal === undefined ? undefined : { signal })
  try {
    guard()
    const header = handle.header ?? {}
    if (String(header.id ?? '') !== agentId) throw new Error('dsh-tui: the stored child session id does not match the catalog id')
    if (header.version !== SESSION_FORMAT_VERSION) throw new Error('dsh-tui: the stored child session format is not supported')
    const statedParent = header.parentSession
    if (statedParent !== undefined && statedParent !== null && String(statedParent) !== capture.sessionId) {
      throw new Error('dsh-tui: the stored child session belongs to another parent')
    }
    // The fork-inherited prefix is part of the stored log but not the child's
    // own history: page from the exact cut only. A seeded header that does
    // not state its cut fails closed; zero is never assumed.
    const cut = header.isSeeded === true
      ? optionalCount(handle.inheritedEventCount)
      : Math.max(0, optionalCount(handle.inheritedEventCount) ?? 0)
    if (cut === undefined) throw new Error('dsh-tui: the seeded child log does not state its inherited cut')

    // The log's total length: `stat().eventCount` when the host states one,
    // re-verified by a single one-event probe at that offset, because appends
    // since the stat must not hide the newest page (a grown log falls into
    // the bounded tail probe). Without a usable count the probe path verifies
    // the inherited boundary first: the stored log always contains the prefix,
    // so an empty event at `cut - 1` is corruption, not an empty child.
    let total: number
    if (statCount !== undefined && statCount >= cut) {
      guard()
      signal?.throwIfAborted()
      const freshness = await handle.read(statCount, 1, signal === undefined ? undefined : { signal })
      total = freshness.events.length > 0 ? await probeLogEnd(handle, statCount, guard, signal) : statCount
    } else {
      if (cut > 0) {
        guard()
        signal?.throwIfAborted()
        const boundary = await handle.read(cut - 1, 1, signal === undefined ? undefined : { signal })
        if (boundary.events.length === 0) throw new Error('dsh-tui: the stored child log is shorter than its inherited cut')
      }
      guard()
      signal?.throwIfAborted()
      const ownStart = await handle.read(cut, 1, signal === undefined ? undefined : { signal })
      total = ownStart.events.length > 0 ? await probeLogEnd(handle, cut, guard, signal) : cut
    }
    guard()

    const own = Math.max(0, total - cut)
    let start: number
    let length: number
    if (window === undefined) {
      length = Math.min(CHILD_TRANSCRIPT_PAGE_EVENTS, own)
      start = cut + own - length
    } else {
      // An older slice: `count` own events ending just before `skipFromStart`
      // (the pagination bookkeeping of the page already shown).
      const skip = Math.max(0, Math.min(window.skipFromStart, own))
      length = Math.max(0, Math.min(window.count, skip))
      start = cut + skip - length
    }
    const events = length === 0 ? [] : (await handle.read(start, length, signal === undefined ? undefined : { signal })).events
    guard()

    // 4. one throwaway translator per call; only leaf events survive, each
    //    forced onto the child lane so the shared fold consumes them exactly
    //    like Claude's replayClaudeSubagentLane output. Nothing here runs the
    //    channel projector, so no todo/job/goal side effects can fire.
    const translator = deps.createTranslator()
    const lane: AgentEvent[] = []
    const uuids: string[] = []
    const pageCalls = new Set<string>()
    for (const event of events) {
      const messageId = durableMessageId(event)
      if (messageId !== undefined) uuids.push(messageId)
      for (const translated of translator.translateEvent(event)) {
        if (translated.type === 'tool.call') pageCalls.add(translated.callId)
        if (translated.type === 'tool.result' && !pageCalls.has(translated.callId)) {
          // Its call sits on an older page, so the translator never saw it
          // and left the body out. Keep the body, so whoever pairs this result
          // with the call from that page has what the card shows.
          lane.push({ ...orphanResult(translated, event as SessionEvent<'tool/result'>), parentCallId: agentId })
        } else if (translated.type === 'assistant.message' || translated.type === 'tool.call' || translated.type === 'tool.result') {
          lane.push({ ...translated, parentCallId: agentId })
        }
      }
    }
    const skippedFromStart = Math.max(0, start - cut)
    return {
      events: lane,
      // The parent is a verified fact (roster + stored lineage), never inferred.
      parentAgentId: capture.sessionId,
      uuids,
      hasOlder: skippedFromStart > 0,
      skippedFromStart,
    }
  } finally {
    // Close exactly once on every path; a read handle's close failure must
    // not discard a page that was already read.
    await handle.close().catch(() => undefined)
  }
}

/** A result whose call was not on the page, with the body a paired card shows. */
function orphanResult(result: AgentEventOf<'tool.result'>, event: SessionEvent<'tool/result'>): AgentEventOf<'tool.result'> {
  return result.isError
    ? { ...result, text: '', errorText: toolErrorText(event) }
    : { ...result, text: textOfBlocks(result.content) }
}

/**
 * The durable message ids that exist on the DSH wire (the `user/message`
 * payload id and the `assistant/message` API message id), verbatim. Missing
 * ids stay missing; nothing fabricates a UUID.
 */
function durableMessageId(event: SessionEvent): string | undefined {
  const type = (event as { type?: unknown }).type
  if (type === 'user/message') {
    const id = (event as { data?: { id?: unknown } }).data?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }
  if (type === 'assistant/message') {
    const id = (event as { data?: { message?: { id?: unknown } } }).data?.message?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }
  return undefined
}
