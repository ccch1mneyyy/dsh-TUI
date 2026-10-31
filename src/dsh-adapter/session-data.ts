/**
 * ctx.tuiSessionData — host session data for plugin views (experimental).
 *
 * Two reads, both called from a live non-root plugin activation and released
 * with its fiber (same admission as tuiPanels/tuiStatus: requirePluginCaller
 * → activationFiber → bindCallerEffect, refusal = warn + `undefined` plus a
 * `failed` effect-ledger record for budget refusals):
 *
 * - `watchProjection(key)` — one projection value of the session ON SCREEN,
 *   with the whole bind/rebind/background/registry lifecycle handled by the
 *   composition root's {@link SessionProjectionHub}. The value is the raw
 *   wire value: the plugin narrows its own projection, the host never reads
 *   it. Budget: 8 watches per activation, 64 distinct keys process-wide.
 * - `watchSessionList()` — the host's session listing, as the Web session
 *   list builds it (`dsh-api-session-controller`'s `ApiSessionList`): rows
 *   from `ctx.sessionQuery.listSessions()` (live-preferred corpus; without
 *   it the `sessionPersistence` headers plus the live `ctx.sessions`), and
 *   projection values only where the host already holds them — the live
 *   registry's materialized cells (`sessionProjections.cachedSnapshot`) for
 *   an attached session, the persisted projection cache
 *   (`sessionProjectionCache.cachedSnapshot`) for a cold one. No log is
 *   read or folded for a projection: a session neither source answers for
 *   simply has no value under that key. Reads run off the render path, in
 *   bounded slices, never overlap, and start at most once a second per
 *   watch (refresh bursts coalesce into one trailing read). Budget: 2 per
 *   activation.
 *
 * A composition without the DSH kernel (a Claude or Codex session, a bare
 * profile) has no registry and no listing: watches read `undefined`, lists
 * read `[]`, nothing throws.
 *
 * @module
 */

import { basename } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanRenderText } from './sanitize.js'
import { activationFiber, assertCallerContext, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import { assertCapabilityShadowPolicy, type AdapterRuntimeOptions } from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import { sessionProjectionHubFor, type SessionProjectionHub } from './session-projection-hub.js'
import { readHeader, type RawSessionHeader } from './sessions/header.js'
import { enumerateSessions, type ListingClock, type SessionSource } from './sessions/list.js'

/** Live projection watches one activation may hold. */
export const MAX_PROJECTION_WATCHES_PER_ACTIVATION = 8
/** Distinct projection keys watched process-wide. */
export const MAX_PROJECTION_KEYS_TOTAL = 64
/** Live session-list watches one activation may hold. */
export const MAX_SESSION_LIST_WATCHES_PER_ACTIVATION = 2
/** Longest accepted projection key. */
export const MAX_PROJECTION_KEY_LENGTH = 128
/** Projection keys one session-list watch may request per row. */
export const MAX_SESSION_LIST_PROJECTION_KEYS = 8
/** Least time between two listing reads of one session-list watch. */
export const SESSION_LIST_MIN_INTERVAL_MS = 1_000

/** Title display budget, in terminal cells. */
const TITLE_CELLS = 200
/** Source code units a title (or workspace name) is cut to before it is
 *  sanitized: eight per cell of its budget, far past any real title, so a
 *  hostile or corrupt one — a zero-width or combining-mark flood — costs a
 *  bounded clean and measure and never lands whole in a row. */
const TITLE_SOURCE_UNITS = TITLE_CELLS * 8

function boundTitleSource(text: string): string {
  if (text.length <= TITLE_SOURCE_UNITS) return text
  const last = text.charCodeAt(TITLE_SOURCE_UNITS - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? TITLE_SOURCE_UNITS - 1 : TITLE_SOURCE_UNITS)
}
/** Listing work slice before yielding to the event loop (render, input). */
const LIST_SLICE_MS = 8
/** Keys every listing reads for its own columns: the durable title and the
 *  Web list's activity metadata. */
const TITLE_KEY = 'title'
const LIST_METADATA_KEY = 'sessionListMetadata'

/** One projection value of the session on screen. */
export interface TuiProjectionWatch {
  readonly key: string
  /** The session on screen; `undefined` until a DSH session binds. */
  readonly sessionId: string | undefined
  /**
   * The raw wire value, narrowed by the plugin itself. `undefined` while no
   * session is bound, when the key is not registered, when the composition
   * has no projection registry (Claude/Codex sessions, a bare profile), or
   * before the session has a value. The reference is stable while unchanged:
   * `React.useSyncExternalStore(watch.subscribe, watch.read)` works as is.
   */
  read(): unknown
  /** Notified when the value or the session on screen changes. */
  subscribe(listener: () => void): () => void
}

/** One listed session. */
export interface TuiSessionListRow {
  readonly id: string
  /** Durable title, else the workspace basename, else the id prefix; control
   *  characters stripped, whitespace folded, at most 200 cells. */
  readonly title: string
  readonly cwd: string | undefined
  /** Creation time, or the last human prompt when the host records it. */
  readonly updatedAt: number | undefined
  /** An attached agent is running a turn. */
  readonly running: boolean
  /** The delegating session of a sub-agent run. */
  readonly parentId: string | undefined
  /** The requested keys the host could answer without reading a log; a key
   *  it could not answer is absent (not `undefined`-valued). */
  readonly projections: Readonly<Record<string, unknown>>
}

export interface TuiSessionListOptions {
  /** Projection keys to fill per row (at most 8, each a valid key). */
  readonly projections?: readonly string[]
}

/** The host's session list. */
export interface TuiSessionListWatch {
  /** Rows, newest activity first; `[]` until the first read completes. The
   *  array reference is stable until the next completed read. */
  read(): readonly TuiSessionListRow[]
  /** The first subscriber (again, after the last one left) triggers a read. */
  subscribe(listener: () => void): () => void
  /**
   * Read the listing again. Reads never overlap and start at most once a
   * second: calls during a read or within that second coalesce into one
   * trailing read, so refreshing on every change is safe.
   */
  refresh(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiSessionData: TuiSessionDataRuntime
  }
}

export const name = 'dsh-tui-session-data'

// ── session listing ─────────────────────────────────────────────────────────

interface ProjectionBlockLike {
  readonly values: Readonly<Record<string, unknown>>
}

/** The host services a listing reads; every one optional and structural. */
export interface SessionListSources {
  /** `ctx.sessionQuery`: the live-preferred corpus. */
  readonly query?: { listSessions?(signal?: AbortSignal): Promise<readonly unknown[]> }
  /** `ctx.sessionPersistence`, when no query service is composed. */
  readonly persistence?: SessionSource
  /** `ctx.sessions`: attached sessions. */
  readonly sessions?: { get?(id: string): unknown; list?(): Iterable<unknown> }
  /** `ctx.agents`: running state. */
  readonly agents?: { get?(id: string): { readonly status?: unknown } | undefined }
  /** `ctx.sessionProjections`: materialized cells of attached sessions. */
  readonly projections?: { cachedSnapshot?(session: unknown, keys?: readonly string[]): ProjectionBlockLike | undefined }
  /** `ctx.sessionProjectionCache`: durable checkpoints of cold sessions. */
  readonly projectionCache?: {
    cachedSnapshot?(header: unknown, keys?: readonly string[]): ProjectionBlockLike | undefined
    cachedPredecessorTitle?(header: unknown): ProjectionBlockLike | undefined
  }
}

interface ListedSession {
  readonly header: RawSessionHeader
  /** The header as the host returned it: the projection cache's identity witness. */
  readonly raw: unknown
}

const yieldTurn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

function abortError(): Error {
  const error = new Error('session listing superseded')
  error.name = 'AbortError'
  return error
}

/** The listing's slice clock: a {@link LIST_SLICE_MS} slice of work, then
 *  the turn goes back to the event loop (render, input), and a superseded
 *  read stops there. */
function sliceClock(signal: AbortSignal): ListingClock {
  let deadline = performance.now() + LIST_SLICE_MS
  return {
    due: () => performance.now() >= deadline,
    async next() {
      await yieldTurn()
      if (signal.aborted) throw abortError()
      deadline = performance.now() + LIST_SLICE_MS
    },
  }
}

/** Rows sorted in one synchronous step by {@link sortYielding}. */
const SORT_RUN = 256

/**
 * A stable sort that keeps the listing's slice guarantee: runs of
 * {@link SORT_RUN} rows are sorted natively, then merged pass by pass, and
 * the work yields to the event loop whenever a {@link LIST_SLICE_MS} slice is
 * used up — a long history must not freeze input for one O(n log n) step.
 */
async function sortYielding<T>(items: readonly T[], compare: (a: T, b: T) => number, clock: ListingClock): Promise<T[]> {
  const pause = async (): Promise<void> => {
    if (clock.due()) await clock.next()
  }
  let source: T[] = []
  for (let start = 0; start < items.length; start += SORT_RUN) {
    for (const item of items.slice(start, start + SORT_RUN).sort(compare)) source.push(item)
    await pause()
  }
  let target = new Array<T>(source.length)
  for (let width = SORT_RUN; width < source.length; width *= 2) {
    for (let left = 0; left < source.length; left += 2 * width) {
      const middle = Math.min(left + width, source.length)
      const end = Math.min(left + 2 * width, source.length)
      let i = left
      let j = middle
      let k = left
      while (i < middle && j < end) {
        // Ties take the left run: equal rows keep their order.
        target[k++] = compare(source[j]!, source[i]!) < 0 ? source[j++]! : source[i++]!
        if ((k & 1023) === 0) await pause()
      }
      // The tails copy up to half the list on an already-ordered input: they
      // keep to the same slices as the comparisons.
      while (i < middle) {
        target[k++] = source[i++]!
        if ((k & 1023) === 0) await pause()
      }
      while (j < end) {
        target[k++] = source[j++]!
        if ((k & 1023) === 0) await pause()
      }
      await pause()
    }
    const merged = target
    target = source
    source = merged
  }
  return source
}

async function listHeaders(sources: SessionListSources, signal: AbortSignal, clock: ListingClock): Promise<ListedSession[]> {
  const query = sources.query
  if (typeof query?.listSessions === 'function') {
    const records = await query.listSessions(signal)
    if (signal.aborted) throw abortError()
    const listed: ListedSession[] = []
    for (const record of records) {
      const raw = record !== null && typeof record === 'object' ? (record as { header?: unknown }).header : undefined
      const header = readHeader(raw)
      if (header !== undefined) listed.push({ header, raw })
      if (clock.due()) await clock.next()
    }
    return listed
  }
  if (sources.persistence === undefined) return []
  const stored = await enumerateSessions(sources.persistence, signal, clock)
  // Wrappers and the id set in one sliced pass, not two whole-list copies.
  const listed: ListedSession[] = []
  const seen = new Set<string>()
  for (const entry of stored) {
    listed.push({ header: entry.header, raw: entry.raw })
    seen.add(entry.header.id)
    if (clock.due()) await clock.next()
  }
  // The query service merges attached sessions the store has not written
  // yet; without it, add them from the live table.
  for (const session of sources.sessions?.list?.() ?? []) {
    const raw = (session as { header?: unknown } | null)?.header
    const header = readHeader(raw)
    if (header !== undefined && !seen.has(header.id)) {
      seen.add(header.id)
      listed.push({ header, raw })
    }
    if (clock.due()) await clock.next()
  }
  return listed
}

function projectionHints(sources: SessionListSources, entry: ListedSession, live: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  if (live !== undefined) return sources.projections?.cachedSnapshot?.(live, keys)?.values
  const cache = sources.projectionCache
  const primary = cache?.cachedSnapshot?.(entry.raw, keys)?.values
  // A partial snapshot (some requested keys answered, `title` not) still
  // takes the predecessor's title, like an absent snapshot does.
  if (primary !== undefined && Object.hasOwn(primary, 'title')) return primary
  const predecessor = cache?.cachedPredecessorTitle?.(entry.raw)?.values
  if (primary === undefined) return predecessor
  if (predecessor === undefined || !Object.hasOwn(predecessor, 'title')) return primary
  return { ...primary, title: predecessor.title }
}

function lastPromptAt(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const at = (value as { lastPromptAt?: unknown }).lastPromptAt
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined
}

/** A cwd's workspace name, read from a bounded tail of the path (never half a
 *  surrogate pair): `basename` must not scan a malformed multi-megabyte path. */
function workspaceName(cwd: string): string {
  const tailUnits = TITLE_SOURCE_UNITS * 2
  if (cwd.length <= tailUnits) return boundTitleSource(basename(cwd))
  let tail = cwd.slice(cwd.length - tailUnits)
  const first = tail.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1)
  return boundTitleSource(basename(tail))
}

function rowTitle(header: RawSessionHeader, title: unknown): string {
  const durable = typeof title === 'string' ? cleanRenderText(boundTitleSource(title), TITLE_CELLS) : ''
  if (durable !== '') return durable
  return cleanRenderText(workspaceName(header.cwd ?? ''), TITLE_CELLS) || cleanRenderText(idPrefix(header.id), TITLE_CELLS)
}

/** The first eight code units of a session id (never half a surrogate pair):
 *  ids are host strings too, sanitized like every other title source. */
function idPrefix(id: string): string {
  const prefix = id.slice(0, 8)
  const last = prefix.charCodeAt(prefix.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix
}

/**
 * Read the host's session listing once.
 *
 * Rows follow the Web session list: an attached session always, a cold one
 * only with a workspace (`cwd`). Projection values come from what the host
 * already holds — never a log read or fold — and a failed projection read
 * costs that row its values, never the listing.
 * @param sources - The host services (see {@link resolveSessionListSources}).
 * @param keys - Projection keys to fill per row.
 * @param signal - Supersedes the read.
 * @param onProjectionError - Told once per failing row.
 * @returns rows, newest activity first.
 */
export async function listSessionRows(
  sources: SessionListSources,
  keys: readonly string[],
  signal: AbortSignal,
  onProjectionError?: (error: unknown, sessionId: string) => void,
): Promise<readonly TuiSessionListRow[]> {
  // One clock for the whole read: header normalization, rows and ordering
  // all work in slices and observe a superseding abort between them.
  const clock = sliceClock(signal)
  const listed = await listHeaders(sources, signal, clock)
  if (signal.aborted) throw abortError()
  const readKeys = [...new Set([...keys, TITLE_KEY, LIST_METADATA_KEY])]
  const rows: TuiSessionListRow[] = []
  for (const entry of listed) {
    const { header } = entry
    const live = sources.sessions?.get?.(header.id)
    if (live !== undefined || header.cwd !== undefined) {
      let hints: Readonly<Record<string, unknown>> | undefined
      try {
        hints = projectionHints(sources, entry, live, readKeys)
      } catch (error) {
        onProjectionError?.(error, header.id)
      }
      const projections: Record<string, unknown> = {}
      for (const key of keys) {
        // Defined, not assigned: a requested `__proto__` must be an own key,
        // not a call to the inherited setter.
        if (hints !== undefined && Object.hasOwn(hints, key)) {
          Object.defineProperty(projections, key, { value: hints[key], enumerable: true, writable: true, configurable: true })
        }
      }
      const prompted = lastPromptAt(hints?.[LIST_METADATA_KEY])
      const created = header.createdAt
      rows.push(Object.freeze({
        id: header.id,
        title: rowTitle(header, hints?.[TITLE_KEY]),
        cwd: header.cwd,
        updatedAt: created === undefined && prompted === undefined ? undefined : Math.max(created ?? 0, prompted ?? 0),
        running: sources.agents?.get?.(header.id)?.status === 'running',
        parentId: header.parentSession,
        projections: Object.freeze(projections),
      }))
    }
    if (clock.due()) await clock.next()
  }
  // Stable: equal activity keeps the host's own order; unknown sorts last.
  return Object.freeze(await sortYielding(rows, (a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1), clock))
}

/**
 * The listing's host services, resolved softly at read time (the kernel's
 * services compose after the extensions row, and may be re-provided).
 * @param ctx - The service's own context.
 * @returns whatever the composition provides.
 */
export function resolveSessionListSources(ctx: Context): SessionListSources {
  const get = (name: string): unknown => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  return {
    query: get('sessionQuery') as SessionListSources['query'],
    persistence: get('sessionPersistence') as SessionListSources['persistence'],
    sessions: get('sessions') as SessionListSources['sessions'],
    agents: get('agents') as SessionListSources['agents'],
    projections: get('sessionProjections') as SessionListSources['projections'],
    projectionCache: get('sessionProjectionCache') as SessionListSources['projectionCache'],
  }
}

const EMPTY_ROWS: readonly TuiSessionListRow[] = Object.freeze([])

/**
 * Create the watch behind `watchSessionList`. Reads never overlap and start
 * at most once per `minIntervalMs`: a `refresh()` (or a first subscriber)
 * during a read or inside that interval only marks the listing stale, and
 * the whole burst is served by ONE trailing read when both have passed. A
 * plugin that refreshes on every projection change — or from its own list
 * listener — therefore costs at most one listing per interval.
 * @param load - One listing read.
 * @param onLoadError - Told about a failed read (the previous rows stay).
 * @param onListenerError - Told about a throwing listener.
 * @param minIntervalMs - Least time between two read starts.
 * @returns the plugin-facing watch and its disposer.
 */
export function createSessionListWatch(
  load: (signal: AbortSignal) => Promise<readonly TuiSessionListRow[]>,
  onLoadError: (error: unknown) => void,
  onListenerError: (error: unknown) => void,
  minIntervalMs: number = SESSION_LIST_MIN_INTERVAL_MS,
): { readonly watch: TuiSessionListWatch; dispose(): void } {
  let rows = EMPTY_ROWS
  const listeners = new Set<() => void>()
  let inflight: AbortController | undefined
  /** A read was asked for while one ran or inside the interval. */
  let stale = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastStartAt = Number.NEGATIVE_INFINITY
  let disposed = false
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        onListenerError(error)
      }
    }
  }
  const cancelTimer = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
  const start = (): void => {
    cancelTimer()
    stale = false
    const controller = new AbortController()
    inflight = controller
    lastStartAt = performance.now()
    const settle = (): void => {
      inflight = undefined
      if (stale) request()
    }
    load(controller.signal).then(next => {
      if (disposed || inflight !== controller) return
      // An aborted read only frees the slot: nobody asked for its rows, and
      // a read a new subscriber asked for meanwhile starts now.
      if (controller.signal.aborted) {
        settle()
        return
      }
      rows = next
      // Settle before notifying: a listener that refreshes lands in the
      // interval and coalesces instead of starting a read of its own.
      settle()
      emit()
    }, (error: unknown) => {
      if (disposed || inflight !== controller) return
      // A failed read is not an empty store: the previous rows stay.
      settle()
      if (!controller.signal.aborted) onLoadError(error)
    })
  }
  /** Ask for a read: now when nothing runs and the interval has passed,
   *  otherwise once, after both. */
  function request(): void {
    stale = true
    if (disposed || inflight !== undefined || timer !== undefined) return
    const wait = lastStartAt + minIntervalMs - performance.now()
    if (wait <= 0) {
      start()
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      if (!disposed && stale && inflight === undefined) start()
    }, wait)
  }
  const watch: TuiSessionListWatch = Object.freeze({
    read: () => (disposed ? EMPTY_ROWS : rows),
    subscribe(listener: () => void) {
      if (disposed || typeof listener !== 'function') return () => {}
      const own = (): void => { listener() }
      listeners.add(own)
      if (listeners.size === 1) request()
      return () => {
        if (!listeners.delete(own) || listeners.size > 0) return
        // Nobody observes the read in flight (or the pending one) any more.
        // It stays in flight until it settles — a host that honours the
        // signal late (or not at all) must never run two listings at once.
        inflight?.abort()
        cancelTimer()
        stale = false
      }
    },
    refresh() {
      if (!disposed) request()
    },
  })
  return {
    watch,
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      inflight?.abort()
      inflight = undefined
      cancelTimer()
      stale = false
      rows = EMPTY_ROWS
    },
  }
}

// ── service ─────────────────────────────────────────────────────────────────

interface SessionDataState {
  readonly runtime: AdapterRuntimeOptions
  readonly hub: SessionProjectionHub
  /** The service's own context: host services resolve here, never through
   *  a caller's shadow. */
  readonly ctx: Context
}

const sessionDataStates = new WeakMap<TuiSessionDataRuntime, SessionDataState>()
/** Live watches per activation fiber. */
const projectionWatches = new WeakMap<object, number>()
const sessionListWatches = new WeakMap<object, number>()
/** Watches holding each distinct projection key, across every composition
 *  root: the key budget is process-wide, the values stay in each root's hub. */
const watchedProjectionKeys = new Map<string, number>()

function sessionDataStateFor(runtime: TuiSessionDataRuntime): SessionDataState {
  const state = sessionDataStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiSessionData host state is unavailable')
  return state
}

/** Whether `key` is an acceptable projection key. */
function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_PROJECTION_KEY_LENGTH
    // eslint-disable-next-line no-control-regex -- keys reach log lines
    && !/[\x00-\x1f\x7f-\x9f]/u.test(key)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Admission shared by both reads; `undefined` after the warning. */
function admitCaller(service: TuiSessionDataRuntime, context: Context, capability: string, identity: Context | undefined): { caller: Context; owner: object } | undefined {
  let caller: Context
  try {
    caller = requirePluginCaller(context, capability, service)
  } catch {
    context.logger.warn(`dsh-tui: ${capability} requires a live non-root plugin activation`)
    return undefined
  }
  if (identity !== undefined) {
    try {
      assertCallerContext(caller, identity, capability)
    } catch {
      caller.logger.warn(`dsh-tui: ${capability} rejected an identity belonging to another activation`)
      return undefined
    }
  }
  const owner = activationFiber(caller)
  if (owner === undefined) {
    caller.logger.warn(`dsh-tui: ${capability} requires a live activation owner`)
    return undefined
  }
  return { caller, owner }
}

/**
 * `ctx.tuiSessionData` — session data for plugin views. Refusals warn and
 * return `undefined` (feature-detectable), never throw at the plugin.
 */
export class TuiSessionDataRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiSessionData')
    compositionRoot(ctx)
    const hub = sessionProjectionHubFor(ctx)
    hub.connect(ctx)
    sessionDataStates.set(this, { runtime: adapterRuntimeFor(ctx), hub, ctx })
  }

  /**
   * Watch one projection value of the session on screen; released with the
   * caller's fiber. The optional identity only feeds the effect ledger's
   * pluginId (same meaning as tuiStatus.set).
   */
  watchProjection(key: string, identity?: Context): TuiProjectionWatch | undefined {
    const state = sessionDataStateFor(this)
    try {
      assertCapabilityShadowPolicy('host.session-data.watch-projection', state.runtime.mode, state.runtime.slices)
    } catch {
      // A shadow mode refuses like every other refusal here: warn, undefined.
      this.ctx.logger.warn('dsh-tui: tuiSessionData.watchProjection refused by the adapter shadow policy')
      return undefined
    }
    const admitted = admitCaller(this, this.ctx, 'tuiSessionData.watchProjection', identity)
    if (admitted === undefined) return undefined
    const { caller, owner } = admitted
    if (!validKey(key)) {
      caller.logger.warn(`dsh-tui: tuiSessionData.watchProjection rejected an invalid key — a non-empty string of at most ${MAX_PROJECTION_KEY_LENGTH} characters without control characters`)
      return undefined
    }
    const resource = { kind: 'subscription', id: `projection:${key}` }
    const held = projectionWatches.get(owner) ?? 0
    if (held >= MAX_PROJECTION_WATCHES_PER_ACTIVATION) {
      caller.logger.warn(`dsh-tui: tuiSessionData.watchProjection rejected "${key}" — a plugin may hold at most ${MAX_PROJECTION_WATCHES_PER_ACTIVATION} projection watches`)
      caller.get('tuiEffectLedger')?.record({ operation: 'bind', resource, result: 'failed', errorCode: 'SESSION_DATA_BUDGET_EXCEEDED' }, identity)
      return undefined
    }
    if (!watchedProjectionKeys.has(key) && watchedProjectionKeys.size >= MAX_PROJECTION_KEYS_TOTAL) {
      caller.logger.warn(`dsh-tui: tuiSessionData.watchProjection rejected "${key}" — ${MAX_PROJECTION_KEYS_TOTAL} projection keys are already watched`)
      caller.get('tuiEffectLedger')?.record({ operation: 'bind', resource, result: 'failed', errorCode: 'SESSION_DATA_BUDGET_EXCEEDED' }, identity)
      return undefined
    }
    const lease = state.hub.acquire(key, error => {
      caller.logger.warn(`dsh-tui: tuiSessionData listener for "${key}" failed: ${errorText(error)}`)
    })
    projectionWatches.set(owner, held + 1)
    watchedProjectionKeys.set(key, (watchedProjectionKeys.get(key) ?? 0) + 1)
    let disposed = false
    let ledgerApplied = false
    let ownerCleanup: (() => unknown) | undefined
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      lease.release()
      projectionWatches.set(owner, Math.max(0, (projectionWatches.get(owner) ?? 1) - 1))
      const holders = (watchedProjectionKeys.get(key) ?? 1) - 1
      if (holders > 0) watchedProjectionKeys.set(key, holders)
      else watchedProjectionKeys.delete(key)
      if (ledgerApplied) {
        caller.get('tuiEffectLedger')?.record({ operation: 'release', resource, result: 'applied' }, identity)
      }
      const cleanup = ownerCleanup
      ownerCleanup = undefined
      cleanup?.()
    }
    // A failed registration runs the disposer itself (the lease is released).
    if (!bindCallerEffect(caller, dispose, cleanup => { ownerCleanup = cleanup })) return undefined
    caller.get('tuiEffectLedger')?.record({ operation: 'bind', resource, result: 'applied' }, identity)
    ledgerApplied = true
    return Object.freeze({
      key,
      get sessionId() { return lease.sessionId },
      read: () => lease.read(),
      subscribe: (listener: () => void) => lease.subscribe(listener),
    })
  }

  /**
   * Watch the host's session list; released with the caller's fiber. Rows
   * carry the requested projection keys where the host holds a value without
   * reading a log (see the module comment).
   */
  watchSessionList(options?: TuiSessionListOptions, identity?: Context): TuiSessionListWatch | undefined {
    const state = sessionDataStateFor(this)
    try {
      assertCapabilityShadowPolicy('host.session-data.watch-session-list', state.runtime.mode, state.runtime.slices)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiSessionData.watchSessionList refused by the adapter shadow policy')
      return undefined
    }
    const admitted = admitCaller(this, this.ctx, 'tuiSessionData.watchSessionList', identity)
    if (admitted === undefined) return undefined
    const { caller, owner } = admitted
    const raw = options as unknown
    if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
      caller.logger.warn('dsh-tui: tuiSessionData.watchSessionList rejected invalid options')
      return undefined
    }
    const requested = (raw as { projections?: unknown } | undefined)?.projections
    // The cap is checked on the array itself first: a huge list is refused
    // before any of it is validated or copied (duplicates count toward it).
    if (Array.isArray(requested) && requested.length > MAX_SESSION_LIST_PROJECTION_KEYS) {
      caller.logger.warn(`dsh-tui: tuiSessionData.watchSessionList rejected projections — at most ${MAX_SESSION_LIST_PROJECTION_KEYS} keys`)
      return undefined
    }
    if (requested !== undefined && (!Array.isArray(requested) || !requested.every(validKey))) {
      caller.logger.warn(`dsh-tui: tuiSessionData.watchSessionList rejected projections — an array of non-empty keys of at most ${MAX_PROJECTION_KEY_LENGTH} characters`)
      return undefined
    }
    const keys = Object.freeze([...new Set((requested ?? []) as readonly string[])])
    if (keys.length > MAX_SESSION_LIST_PROJECTION_KEYS) {
      caller.logger.warn(`dsh-tui: tuiSessionData.watchSessionList rejected projections — at most ${MAX_SESSION_LIST_PROJECTION_KEYS} keys`)
      return undefined
    }
    const resource = { kind: 'subscription', id: 'session-list' }
    const held = sessionListWatches.get(owner) ?? 0
    if (held >= MAX_SESSION_LIST_WATCHES_PER_ACTIVATION) {
      caller.logger.warn(`dsh-tui: tuiSessionData.watchSessionList rejected — a plugin may hold at most ${MAX_SESSION_LIST_WATCHES_PER_ACTIVATION} session-list watches`)
      caller.get('tuiEffectLedger')?.record({ operation: 'bind', resource, result: 'failed', errorCode: 'SESSION_DATA_BUDGET_EXCEEDED' }, identity)
      return undefined
    }
    const host = state.ctx
    let projectionWarned = false
    let loadWarned = false
    const list = createSessionListWatch(
      signal => listSessionRows(resolveSessionListSources(host), keys, signal, (error, sessionId) => {
        if (projectionWarned) return
        projectionWarned = true
        host.logger.warn(`dsh-tui: session list projections for "${sessionId}" failed; the row is served without them: ${errorText(error)}`)
      }),
      error => {
        if (loadWarned) return
        loadWarned = true
        host.logger.warn(`dsh-tui: session list read failed: ${errorText(error)}`)
      },
      error => { caller.logger.warn(`dsh-tui: tuiSessionData session-list listener failed: ${errorText(error)}`) },
    )
    sessionListWatches.set(owner, held + 1)
    let disposed = false
    let ledgerApplied = false
    let ownerCleanup: (() => unknown) | undefined
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      list.dispose()
      sessionListWatches.set(owner, Math.max(0, (sessionListWatches.get(owner) ?? 1) - 1))
      if (ledgerApplied) {
        caller.get('tuiEffectLedger')?.record({ operation: 'release', resource, result: 'applied' }, identity)
      }
      const cleanup = ownerCleanup
      ownerCleanup = undefined
      cleanup?.()
    }
    if (!bindCallerEffect(caller, dispose, cleanup => { ownerCleanup = cleanup })) return undefined
    caller.get('tuiEffectLedger')?.record({ operation: 'bind', resource, result: 'applied' }, identity)
    ledgerApplied = true
    return list.watch
  }
}

/** Host-only accessor (driver probes, regressions); not exported to plugins. */
export function getHostSessionProjectionHub(runtime: TuiSessionDataRuntime | undefined): SessionProjectionHub | undefined {
  if (runtime === undefined) return undefined
  try {
    return sessionDataStateFor(runtime).hub
  } catch {
    return undefined
  }
}

export default TuiSessionDataRuntime
