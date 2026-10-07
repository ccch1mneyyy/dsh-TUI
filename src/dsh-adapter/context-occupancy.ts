/**
 * Official context occupancy for the footer, the status commands and the
 * context-low warning.
 *
 * Occupancy answers "how full is the window", which is NOT the question the
 * provider usage of the last settled `assistant/message` answers. That sample
 * has two blind spots this module removes:
 *
 * 1. **It is a sample of a *past* request.** A rejected/overflowed request
 *    writes no `assistant/message`, so the sample stays small exactly when the
 *    provider says the prompt is too big.
 * 2. **It cannot see a compaction.** A checkpoint replaces the surface without
 *    reporting usage of its own.
 *
 * DSH's token meter already projects both away: `contextPressure.projectedTokens`
 * is the provider-anchored sample plus the signed surface movement since it was
 * taken, i.e. the occupancy of the NEXT request. The Web UI reads that value
 * through `ui-conversation`'s `contextOccupancy()`; this module reads the same
 * projection through the same legal seam `activity-store.ts` uses
 * (`ctx.inject(['sessionProjections'])` + the structural registry duck type +
 * a cleanup on the injected fiber).
 *
 * Two properties shape the transport here:
 *
 * 1. **The change feed carries the whole value.** `onChanged` hands one unit's
 *    schema-validated wire view (`session-projection/index.d.ts`), so this
 *    module never folds history to stay current — only the session BIND reads
 *    one snapshot, because a value that has not changed since it was published
 *    never arrives again and a resumed session would otherwise show nothing.
 * 2. **Absence is normal.** A bare `cordis.yml` composition has no dsh-base
 *    bundle and therefore no token meter; the projection key is simply not
 *    registered. The store stays empty and the channel falls back to the
 *    last-request sample it has always shown (see `resolveContextOccupancy`).
 *
 * The SAME unit also publishes `contextBreakdown` — the heuristic composition of
 * that total (system prompt / request-envelope tool schemas / everything else).
 * This module reads it on the same seam and stores it beside the occupancy,
 * because the segmented bar draws what the context is made of while its length
 * and readout must follow the provider-anchored total: without the composition
 * the bar had to price its own transcript text, which systematically misses the
 * request envelope (tool schemas) and the injected context. Absence is normal
 * here too — a meter older than the projection publishes no composition, and the
 * bar keeps using this app's own estimates alone.
 * @module dsh-tui/dsh-adapter/context-occupancy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContextBreakdown, ContextOccupancy } from '../adapter/ports/channel-view.js'
// The registry duck type is declared beside the activity feed, which reads the
// same host service; one structural declaration serves both readers.
import type { ProjectionRegistryLike } from './activity-store.js'

/** The projection key the host token meter publishes. */
export const CONTEXT_PRESSURE_PROJECTION_KEY = 'contextPressure'

/** The composition key the SAME meter unit publishes (see
 *  {@link ContextBreakdownView}); absent on harness lines whose meter predates
 *  it, which every reader here treats as "no composition known". */
export const CONTEXT_BREAKDOWN_PROJECTION_KEY = 'contextBreakdown'

/** The two keys of the one meter unit this store folds. Each maps to its own
 *  table, so the write path is typed by key: a third key — or a typo — cannot
 *  compile its way into an occupancy value. */
type ContextMeterKey = typeof CONTEXT_PRESSURE_PROJECTION_KEY | typeof CONTEXT_BREAKDOWN_PROJECTION_KEY

/** Narrow an arbitrary change-feed key to the two this store folds.
 * @param key - Projection key as the feed reports it.
 * @returns whether the key belongs to the context meter unit.
 */
function isContextMeterKey(key: string): key is ContextMeterKey {
  return key === CONTEXT_PRESSURE_PROJECTION_KEY || key === CONTEXT_BREAKDOWN_PROJECTION_KEY
}

/**
 * The official `contextPressure` wire value.
 *
 * Structural copy of `@deepseek-ai/dsh-token-meter`'s `ContextPressureProjection`:
 * the value is host data, so this app declares the shape it reads instead of
 * importing the meter (the same discipline `activity-store.ts` applies to
 * `workingActivity`).
 */
export interface ContextPressureView {
  /** Provider-reported prompt size (uncached input + cache reads/writes) of the newest request. */
  readonly pressureTokens?: number
  /** What the NEXT request's prompt would cost: {@link pressureTokens} plus the surface's movement since. */
  readonly projectedTokens?: number
  /** Newest recorded route capacity, when an adapter advertised one. */
  readonly contextWindow?: number
}

/**
 * The official `contextBreakdown` wire value.
 *
 * Structural copy of `@deepseek-ai/dsh-token-meter`'s `ContextBreakdownProjection`,
 * the composition half of the same meter unit that publishes `contextPressure`:
 * system prompt, the newest request envelope's TOOL SCHEMAS, and everything else
 * on the surface. Its own doc is explicit that the three are a heuristic
 * composition — "approximations of composition, never … a total" — because the
 * fixed density estimator underprices CJK text and JSON schemas; the
 * provider-anchored total stays `contextPressure`.
 *
 * Fields are optional here even though the host declares them required: a
 * partially-filled wire value must degrade to "this part is unknown" instead of
 * discarding the whole reading (the discipline {@link ContextPressureView} keeps).
 */
export interface ContextBreakdownView {
  /** Heuristic tokens of the last nonempty surviving system prompt. */
  readonly systemTokens?: number
  /** Heuristic tokens of the newest request envelope's tool schemas. */
  readonly toolsTokens?: number
  /** Heuristic tokens of every other visible surface node (including
   *  superseded system prompts and injected context). */
  readonly messageTokens?: number
}

/**
 * The reader the channel gets: a cached lookup plus a change feed.
 *
 * Reading is a map hit (never a fold), so a render may call it freely; the
 * subscription is what lets the channel republish when the projection moves
 * between session events (compaction, surface growth).
 */
export interface ContextPressureSource {
  read(sessionId: string): ContextPressureView | undefined
  /** The same unit's composition value, when the harness publishes it. An
   *  absent method (or an absent value) means the bar falls back to this app's
   *  own per-content-type estimates alone. */
  readBreakdown?(sessionId: string): ContextBreakdownView | undefined
  subscribe(listener: () => void): () => void
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Narrow one projection value: anything that is not a context-pressure view is
 * dropped rather than rendered half-formed.
 *
 * A well-formed value is passed THROUGH (not copied), the same discipline
 * `activity-store.ts` applies: the host reuses the wire object while its state
 * is unchanged, so identity is the store's change test, and a copy would make
 * every read look like a change.
 * @param value - Raw projection value.
 * @returns the value as a context-pressure view, or `undefined`.
 */
export function asContextPressureView(value: unknown): ContextPressureView | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const fields = ['pressureTokens', 'projectedTokens', 'contextWindow'] as const
  let known = false
  for (const field of fields) {
    const raw = record[field]
    if (raw === undefined) continue
    if (finiteNumber(raw) === undefined) return undefined
    known = true
  }
  return known ? value as ContextPressureView : undefined
}

/**
 * The official numerator: `projectedTokens ?? pressureTokens`.
 *
 * This is the precedence `ui-conversation/src/client/context-occupancy.ts`
 * uses. `projectedTokens` is preferred because it is the only field that
 * answers for the next request; `pressureTokens` is the bare sample and is all
 * a session whose surface total is unknown can offer.
 * @param view - The projection value.
 * @returns the occupancy numerator, or `undefined` before any provider sample.
 */
export function contextPressureUsedTokens(view: ContextPressureView): number | undefined {
  return view.projectedTokens ?? view.pressureTokens
}

/**
 * Narrow one `contextBreakdown` wire value: a value carrying no known field is
 * dropped, a partially-filled one is kept so its known parts still reach the
 * bar. Passed THROUGH (not copied) for the same identity-is-the-change-test
 * reason as {@link asContextPressureView}.
 * @param value - Raw projection value.
 * @returns the value as a breakdown view, or `undefined`.
 */
export function asContextBreakdownView(value: unknown): ContextBreakdownView | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const fields = ['systemTokens', 'toolsTokens', 'messageTokens'] as const
  let known = false
  for (const field of fields) {
    const raw = record[field]
    if (raw === undefined) continue
    if (finiteNumber(raw) === undefined) return undefined
    known = true
  }
  return known ? value as ContextBreakdownView : undefined
}

/**
 * Normalise the host's composition value into the port shape the footer reads,
 * filling absent fields with 0 (a partial value must not blank the sections the
 * host did report).
 * @param view - The narrowed projection value, if any.
 * @returns the composition, or `undefined` when the harness publishes none.
 */
export function resolveContextBreakdown(view: ContextBreakdownView | undefined): ContextBreakdown | undefined {
  if (view === undefined) return undefined
  return {
    systemTokens: view.systemTokens ?? 0,
    toolsTokens: view.toolsTokens ?? 0,
    messageTokens: view.messageTokens ?? 0,
  }
}

/**
 * Resolve the ONE occupancy reading the footer, the segmented bar, the working
 * line's pressure prefix, the status commands and the context-low warning share.
 *
 * DIVERGENCE FROM THE OFFICIAL RENDERER (deliberate, see the PR body): the Web
 * UI renders nothing when the projection carries neither pressure nor a window.
 * The TUI keeps its pre-projection sample readout instead, so a bare
 * `cordis.yml` composition (no dsh-base bundle ⇒ no token meter) does not
 * silently lose a number it has always shown; {@link ContextOccupancy.source}
 * names which path answered. A composition WITH a meter — every normal
 * deployment, where the base bundle mounts token-meter on the host plane —
 * takes the projection branch as soon as a request reports usage, and the
 * fallback becomes unreachable.
 * @param projected - Cached `contextPressure` value, `undefined` without a meter.
 * @param sample - Last settled request's billed usage (the fallback numerator).
 * @param requestWindow - `request/context` capacity (the fallback denominator).
 * @param backendUsage - Backend-measured occupancy; preferred over billed usage
 * when DSH's projection has no reading.
 * @returns the reading, or `undefined` when neither path knows anything.
 */
export function resolveContextOccupancy(
  projected: ContextPressureView | undefined,
  sample: { input: number; cacheRead: number; cacheWrite: number } | undefined,
  requestWindow: number | undefined,
  backendUsage?: { readonly used: number; readonly max?: number },
): ContextOccupancy | undefined {
  const contextWindow = projected?.contextWindow ?? requestWindow
  const projectedUsed = projected === undefined ? undefined : contextPressureUsedTokens(projected)
  if (projectedUsed !== undefined) {
    return { usedTokens: projectedUsed, contextWindow, source: 'projection' }
  }
  if (backendUsage !== undefined) {
    return { usedTokens: backendUsage.used, contextWindow: backendUsage.max ?? contextWindow, source: 'backend' }
  }
  if (sample === undefined) return undefined
  return {
    usedTokens: sample.input + sample.cacheRead + sample.cacheWrite,
    contextWindow,
    source: 'sample',
  }
}

/**
 * The latest `contextPressure` (and, when published, `contextBreakdown`) value
 * for the session on screen.
 *
 * Effectively single-current, mirroring {@link ActivityStore}: binding a
 * session names the one the UI shows, and every other id is dropped — the
 * projection feed is host-wide, and a background session must not overwrite the
 * footer of the session on screen.
 *
 * The store holds VALUES, never sessions to re-read: the feed delivers the
 * whole value, so there is nothing to poll. Only {@link seed} reads a snapshot,
 * and only because a resumed session's value may not have changed (and
 * therefore never been published) since it was last folded.
 */
export class ContextOccupancyStore implements ContextPressureSource {
  private readonly values = new Map<string, ContextPressureView>()
  /** The same sessions' composition values — another key of the SAME meter
   *  unit, folded alongside the pressure so the bar never reads a composition
   *  from a different log position than its total. */
  private readonly breakdowns = new Map<string, ContextBreakdownView>()
  private readonly listeners = new Set<() => void>()
  /** The session the UI is showing (the last {@link seed}); the only id kept. */
  private currentId: string | undefined
  /** Session object behind {@link currentId}, so a late registry can still seed. */
  private currentSession: unknown
  /** Host registry, remembered so a bind can read a baseline on demand. */
  private registry: ProjectionRegistryLike | undefined
  /** Read failures are reported once: a broken registry must not spam the log. */
  private warned = false
  private readonly warn: ((message: string) => void) | undefined

  constructor(warn?: (message: string) => void) {
    this.warn = warn
  }

  /**
   * Remember the host registry. A registry that arrives after the session bound
   * is immediately used to read the baseline {@link seed} could not: the unit
   * and its registry are mounted by other plugins, so the order is not ours.
   * @param registry - The host projection registry.
   */
  attachRegistry(registry: ProjectionRegistryLike): void {
    this.registry = registry
    if (this.currentSession !== undefined) this.seed(this.currentSession)
  }

  /**
   * Bind one session and read its current projection value once.
   *
   * The bind also defines the session on screen: every other id is pruned, so a
   * later background event can no longer fill this store.
   * @param session - Session being bound.
   */
  seed(session: unknown): void {
    if (session === null || session === undefined) return
    this.currentId = String((session as { id: unknown }).id)
    this.currentSession = session
    this.pruneToCurrent()
    const registry = this.registry
    if (registry === undefined) return
    try {
      // Both keys in ONE snapshot: one materialization, one consistent cut.
      // A harness whose meter predates `contextBreakdown` simply omits it.
      const keys = [CONTEXT_PRESSURE_PROJECTION_KEY, CONTEXT_BREAKDOWN_PROJECTION_KEY] as const
      const values = registry.snapshot(session, keys).values
      this.remember(this.currentId, CONTEXT_PRESSURE_PROJECTION_KEY, values[CONTEXT_PRESSURE_PROJECTION_KEY])
      this.remember(this.currentId, CONTEXT_BREAKDOWN_PROJECTION_KEY, values[CONTEXT_BREAKDOWN_PROJECTION_KEY])
    } catch (error) {
      this.noteReadFailure(error)
    }
  }

  /**
   * Record one value from the projection change feed.
   * @param sessionId - Session the value belongs to.
   * @param key - Projection key the value was published under.
   * @param value - The published wire value.
   */
  update(sessionId: string, key: ContextMeterKey, value: unknown): void {
    this.remember(sessionId, key, value)
  }

  /** The current value for one session, stable between updates. */
  read(sessionId: string): ContextPressureView | undefined {
    return this.values.get(sessionId)
  }

  /** The current composition for one session, when the harness publishes it. */
  readBreakdown(sessionId: string): ContextBreakdownView | undefined {
    return this.breakdowns.get(sessionId)
  }

  /** Subscribe to value changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Report a failed registry read once. The sink is the composition root's
   * logger — this module stays free of cordis types.
   * @param error - What the failed read threw.
   */
  noteReadFailure(error: unknown): void {
    if (this.warned) return
    this.warned = true
    const detail = error instanceof Error ? error.message : String(error)
    this.warn?.(`dsh-tui: context-pressure projection read failed: ${detail}`)
  }

  /** Store one already-narrowed value for the current session and emit on change. */
  private remember(sessionId: string, key: ContextMeterKey, value: unknown): void {
    // One key, one table: a key outside this union cannot reach here (see
    // `isContextMeterKey`), so neither table can be written by a typo.
    if (key === CONTEXT_BREAKDOWN_PROJECTION_KEY) {
      this.rememberIn(this.breakdowns, sessionId, asContextBreakdownView(value))
      return
    }
    this.rememberIn(this.values, sessionId, asContextPressureView(value))
  }

  /** One key's map write, with the identity-is-the-change-test rule the host's
   *  reference reuse relies on, and the emit on every real transition. */
  private rememberIn<T>(map: Map<string, T>, sessionId: string, view: T | undefined): void {
    if (this.currentId !== undefined && sessionId !== this.currentId) return
    const previous = map.get(sessionId)
    if (view === undefined) {
      if (previous === undefined) return
      map.delete(sessionId)
      this.emit()
      return
    }
    // The host reuses the view reference while its state is unchanged
    // (`Object.is` suppression in the registry), so an identity check is the
    // whole change test.
    if (previous === view) return
    map.set(sessionId, view)
    this.emit()
  }

  /** Drop every id that is not the current one; emit when a value went. */
  private pruneToCurrent(): void {
    if (this.currentId === undefined) return
    let removed = false
    for (const map of [this.values, this.breakdowns] as Map<string, unknown>[]) {
      for (const id of [...map.keys()]) {
        if (id === this.currentId) continue
        map.delete(id)
        removed = true
      }
    }
    if (removed) this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Wire one store to the host's projection registry.
 *
 * Registration is deferred through `inject` because the plugin that *publishes*
 * the unit is mounted alongside this one: the registry may not exist yet, and
 * the unit may not be registered until later still. Both absences are normal —
 * a composition without the token meter simply never fills the store, and the
 * channel falls back to its own sample.
 *
 * The feed is event-driven and carries the whole value, so a change costs one
 * narrow + one map write. A long resumed session (thousands of replayed events)
 * therefore pays O(changes of this unit) and never a per-event fold; rendering
 * pays a map lookup, never a `snapshot()`. Both keys of the unit ride the one
 * feed/subscription pair: a composition change repaints the bar on the same
 * republish an occupancy change does.
 * @param ctx - Host context of the composition root.
 * @param store - Store to fill.
 */
export function attachContextPressureProjection(ctx: Context, store: ContextOccupancyStore): void {
  ctx.inject(['sessionProjections'] as never, ((projectionCtx: Context) => {
    const registry = (projectionCtx as unknown as {
      sessionProjections?: ProjectionRegistryLike
    }).sessionProjections
    if (registry === undefined) return
    store.attachRegistry(registry)
    let offFeed: (() => void) | undefined
    try {
      offFeed = registry.onChanged((session, key, value) => {
        // Two keys of one unit: the total (occupancy) and the composition.
        if (!isContextMeterKey(key)) return
        store.update(String((session as { id: unknown }).id), key, value)
      })
    } catch (error) {
      store.noteReadFailure(error)
    }
    // The cleanup belongs to the injected fiber, not the outer ctx: a service
    // re-provide re-runs the callback above, and registering on the outer ctx
    // would stack feed listeners (the old listener's disposer would only run
    // when the whole composition root goes down).
    projectionCtx.effect(() => () => {
      offFeed?.()
    }, 'dsh-tui context-pressure projection feed')
  }) as never)
}

/**
 * Create the composition root's occupancy store and wire it to the host.
 *
 * Unlike the activity store there is no config gate: occupancy feeds the
 * footer's ctx field, the segmented bar and the context-low warning, so hiding
 * one surface must not stop the others from being correct.
 * @param ctx - Host context of the composition root.
 * @returns the store the channel reads from.
 */
export function createContextOccupancyStore(ctx: Context): ContextOccupancyStore {
  const store = new ContextOccupancyStore(message => { ctx.logger.warn(message) })
  attachContextPressureProjection(ctx, store)
  return store
}
