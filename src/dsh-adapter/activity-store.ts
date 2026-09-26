/**
 * Session-scoped activity snapshots for the working-status line.
 *
 * The line's *semantics* belong to the `dsh-working-activity` plugin: it folds
 * durable session events and live model frames into a **session projection**
 * (`workingActivity`) that any client can read — the browser reads it, and so
 * does this TUI. Consuming the projection is what removes the second tracker
 * this app used to run: one semantic owner, and a value that arrives already
 * scoped to a session, so a background session can no longer overwrite the line
 * of the session on screen.
 *
 * Two properties of the transport shape this module:
 *
 * 1. **It is event-driven.** A value changes when a committed event folds, never
 *    on its own. `updatedAt` is the timestamp of the last folded event (session
 *    time, so it survives a restart) and `live` says whether `line` counts
 *    elapsed time. A renderer that wants the counter to move must derive it from
 *    `turnStartedAt` / `phaseStartedAt` instead of re-rendering `line`.
 * 2. **The value is host data, not plugin API.** The shape below is a local
 *    structural copy of the plugin's wire value, the same discipline the channel
 *    port already applies to the activity state: this app must not import the
 *    plugin's internals to display a line.
 * @module dsh-tui/dsh-adapter/activity-store
 */

import type { Context } from '@deepseek-ai/cordis'
import React from 'react'

/** The projection key the activity plugin publishes. */
export const ACTIVITY_PROJECTION_KEY = 'workingActivity'

/** Phases the plugin's line can be in (`idle` renders nothing). */
export type ActivityPhase = 'idle' | 'waiting' | 'thinking' | 'tool' | 'done'

/**
 * One session's activity value, as the plugin publishes it.
 *
 * Structural copy of `dsh-working-activity`'s `WorkingActivityView`.
 */
export interface ActivityView {
  readonly phase: ActivityPhase
  /** The line as the host rendered it at `updatedAt`. */
  readonly line: string
  /** Whether `line` counts elapsed time (a renderer ticks it from the stamps). */
  readonly live: boolean
  /** Tool action verb, when the line describes a running tool. */
  readonly label?: string
  /** Tool detail fragment (path / command / pattern), when there is one. */
  readonly detail?: string
  /** The playful phrase or `⏵` self-narration currently shown, when any. */
  readonly phrase?: string
  /** Tools completed in the current turn. */
  readonly toolCount: number
  /** Wall clock the current phase began. */
  readonly phaseStartedAt: number
  /** Wall clock the current turn began (0 when no turn has started). */
  readonly turnStartedAt: number
  /** Timestamp of the last folded event — the value's freshness signal. */
  readonly updatedAt: number
  /** Language the line was rendered in. */
  readonly lang: 'zh' | 'en'
}

/** The slice of the host projection registry this module uses. */
export interface ProjectionRegistryLike {
  onChanged(listener: (
    session: { readonly id: unknown },
    key: string,
    value: unknown,
    seq: number,
  ) => void): () => void
  snapshot(session: unknown, keys?: readonly string[]): { readonly values: Record<string, unknown> }
}

/**
 * Narrow one projection value: anything that is not an activity view is
 * dropped rather than rendered half-formed.
 * @param value - Raw projection value.
 * @returns the value as an activity view, or `undefined`.
 */
export function asActivityView(value: unknown): ActivityView | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.phase !== 'string' || typeof record.line !== 'string') return undefined
  if (!PHASES.has(record.phase)) return undefined
  return value as ActivityView
}

const PHASES = new Set<string>(['idle', 'waiting', 'thinking', 'tool', 'done'])

/**
 * The latest activity value for the session on screen, with a subscription
 * for renderers.
 *
 * The store is effectively single-current: binding a session ({@link
 * ActivityStore.seed}) names the session the UI is showing, and every other
 * id is dropped — values, session objects and read-failure counts alike. A
 * registry-less store (the UI's fallback, test rigs) has no current session
 * and keeps today's accept-all behavior.
 */
export class ActivityStore {
  private readonly values = new Map<string, ActivityView>()
  /** Session objects seen for each id, so a live value can be re-read. */
  private readonly sessions = new Map<string, unknown>()
  /** Consecutive failed reads per session id; reset by a successful read. */
  private readonly readFailures = new Map<string, number>()
  /** Sessions already warned about (see {@link noteReadFailure}): once each. */
  private readonly warned = new Set<string>()
  private readonly listeners = new Set<() => void>()
  /** The session the UI is showing (the last {@link seed}); the only id kept. */
  private currentId: string | undefined
  /** Host registry, remembered so a bind can read a baseline on demand. */
  private registry: ProjectionRegistryLike | undefined
  /** Warn sink (see {@link noteReadFailure}); injected by the composition root. */
  private readonly warn: ((message: string) => void) | undefined

  constructor(warn?: (message: string) => void) {
    this.warn = warn
  }

  /** Remember the host registry (see {@link seed} and {@link refreshLive}). */
  attachRegistry(registry: ProjectionRegistryLike): void {
    this.registry = registry
  }

  /**
   * Seed one session from the registry's current snapshot and make it the
   * current one.
   *
   * A value only *arrives* when it changes, so a session opened after its last
   * change — a resume, or a window reattached to a running agent — would show
   * nothing until the next event without this read. The bind also defines the
   * session on screen: every other id is pruned, so a later event — or the
   * tick — for a session the user switched away from can no longer fill this
   * store or keep a timer armed.
   * @param session - Session being bound.
   */
  seed(session: unknown): void {
    if (session === null || session === undefined) return
    this.currentId = String((session as { id: unknown }).id)
    this.pruneToCurrent()
    seedActivity(this.registry, this, session)
  }

  /**
   * Note the session object behind an id, so a live value can be re-read.
   * Dropped for any id other than the current one (see {@link seed}). */
  remember(sessionId: string, session: unknown): void {
    if (this.currentId !== undefined && sessionId !== this.currentId) return
    this.sessions.set(sessionId, session)
  }

  /**
   * Re-read the current session's value while it is still counting time.
   *
   * The host renders the value when it is *read*, so this is what makes the
   * elapsed seconds advance between committed events — with the host's own copy
   * and language, since nothing is re-rendered here. A value that has settled
   * (`live` false: idle, or a finished turn) is deliberately skipped: its text
   * cannot change on its own. Only the current session can be live (see
   * {@link seed}), so the tick never polls a session the user left.
   */
  refreshLive(): void {
    const registry = this.registry
    if (registry === undefined) return
    for (const [sessionId, value] of [...this.values]) {
      if (!value.live) continue
      const session = this.sessions.get(sessionId)
      if (session === undefined) continue
      seedActivity(registry, this, session)
    }
  }

  /** Whether the current session's value is still counting time (see {@link refreshLive}). */
  hasLive(): boolean {
    for (const value of this.values.values()) if (value.live) return true
    return false
  }

  /** The current value for one session, stable between updates. */
  get(sessionId: string | undefined): ActivityView | undefined {
    if (sessionId === undefined) return undefined
    return this.values.get(sessionId)
  }

  /**
   * Record one projection value. Dropped for any id other than the current
   * one (see {@link seed}).
   * @param sessionId - Session the value belongs to.
   * @param view - The published value.
   */
  update(sessionId: string, view: ActivityView): void {
    if (this.currentId !== undefined && sessionId !== this.currentId) return
    if (this.values.get(sessionId) === view) return
    this.values.set(sessionId, view)
    this.emit()
  }

  /** Forget one session (disposed, or left behind by a reset). */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
    if (!this.values.delete(sessionId)) return
    this.emit()
  }

  /** A read succeeded: this session's consecutive-failure count restarts. */
  noteReadSuccess(sessionId: string): void {
    this.readFailures.delete(sessionId)
  }

  /**
   * A read failed. The failure is reported to the warn sink ONCE per session
   * (the sink is the composition root's logger — this module stays free of
   * cordis types), and after {@link MAX_READ_FAILURES} consecutive failures
   * the value is cleared so the tick disarms instead of polling a registry
   * that will never answer.
   * @param sessionId - Session whose read failed.
   * @param detail - What the failed read threw.
   */
  noteReadFailure(sessionId: string, detail: string): void {
    const failures = (this.readFailures.get(sessionId) ?? 0) + 1
    this.readFailures.set(sessionId, failures)
    if (!this.warned.has(sessionId)) {
      this.warned.add(sessionId)
      this.warn?.(`dsh-tui: working-activity projection read failed for session ${sessionId}: ${detail}`)
    }
    if (failures >= MAX_READ_FAILURES) this.clear(sessionId)
  }

  /** Drop every id that is not the current one; emit when a value went. */
  private pruneToCurrent(): void {
    if (this.currentId === undefined) return
    let removedValue = false
    for (const id of [...this.values.keys()]) {
      if (id === this.currentId) continue
      this.values.delete(id)
      removedValue = true
      this.sessions.delete(id)
      this.readFailures.delete(id)
      this.warned.delete(id)
    }
    for (const id of [...this.sessions.keys()]) {
      if (id === this.currentId) continue
      this.sessions.delete(id)
      this.readFailures.delete(id)
      this.warned.delete(id)
    }
    if (removedValue) this.emit()
  }

  /** Subscribe to value changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * The change-feed listener for one store.
 *
 * Only this plugin's key is read, and only values that narrow to an activity
 * view are accepted: the feed is host-wide, so every other unit's change and
 * every malformed value must be dropped here rather than inside a renderer.
 * @param store - Store to fill.
 * @returns the listener to hand to `ProjectionRegistry.onChanged`.
 */
export function createActivityFeed(
  store: ActivityStore,
): (session: { readonly id: unknown }, key: string, value: unknown) => void {
  return (session, key, value) => {
    if (key !== ACTIVITY_PROJECTION_KEY) return
    const view = asActivityView(value)
    if (view === undefined) return
    const sessionId = String(session.id)
    // Values for a session other than the current one are dropped inside
    // remember/update, so the feed needs no filter of its own.
    store.remember(sessionId, session)
    store.update(sessionId, view)
  }
}

/** How often a value that is still counting time is re-read from the host. */
export const LIVE_TICK_MS = 500

/** Consecutive failed reads before a session's value is dropped (see {@link ActivityStore.noteReadFailure}). */
const MAX_READ_FAILURES = 3

/**
 * Wire one store to the host's projection registry.
 *
 * Registration is deferred through `inject` because the plugin that *publishes*
 * the unit is mounted alongside this one: the registry may not exist yet, and
 * the unit may not be registered until later still. Both absences are normal —
 * a composition without the activity plugin simply never fills the store, and
 * the line falls back to whatever else the UI has.
 *
 * The feed is event-driven, so a value only lands when a committed event folds;
 * its elapsed text would therefore freeze for the length of a long tool. The
 * host renders a value when it is READ, so a timer re-reads the live ones: the
 * seconds advance, the copy and language stay the plugin's, and a settled value
 * (idle, or a finished turn) stops the timer instead of being polled forever.
 * @param ctx - Host context of the composition root.
 * @param store - Store to fill.
 */
export function attachActivityProjection(ctx: Context, store: ActivityStore): void {
  ctx.inject(['sessionProjections'] as never, ((projectionCtx: Context) => {
    const registry = (projectionCtx as unknown as {
      sessionProjections?: ProjectionRegistryLike
    }).sessionProjections
    if (registry === undefined) return
    store.attachRegistry(registry)
    const offFeed = registry.onChanged(createActivityFeed(store))

    let timer: NodeJS.Timeout | undefined
    const stopTimer = (): void => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    /** Arm while something is counting time, disarm the moment nothing is. */
    const reconcileTimer = (): void => {
      if (!store.hasLive()) {
        stopTimer()
        return
      }
      if (timer !== undefined) return
      timer = setInterval(() => {
        store.refreshLive()
      }, LIVE_TICK_MS)
      timer.unref()
    }
    const offStore = store.subscribe(reconcileTimer)
    reconcileTimer()

    // The cleanup belongs to the injected fiber, not the outer ctx: a service
    // re-provide re-runs the callback above, and registering on the outer ctx
    // would stack feed listeners (the old listener's disposer would only run
    // when the whole composition root goes down).
    projectionCtx.effect(() => () => {
      offStore()
      stopTimer()
      offFeed()
    }, 'dsh-tui activity projection feed')
  }) as never)
}

/**
 * Create the composition root's activity store and wire it to the host.
 * @param ctx - Host context of the composition root.
 * @param enabled - Whether the working line is shown at all (cordis.yml
 *   `activity`; a static, config-time switch — the runtime `/activity` command
 *   only changes the preset). With the line off, nothing attaches: no feed,
 *   no registry, and therefore no 500ms tick for a line nobody renders.
 * @returns the store the UI reads from.
 */
export function createActivityStore(ctx: Context, enabled: boolean): ActivityStore {
  const store = new ActivityStore(message => { ctx.logger.warn(message) })
  if (enabled) attachActivityProjection(ctx, store)
  return store
}

/**
 * Read one session's activity value in a component.
 * @param store - Store to read.
 * @param sessionId - Session the UI is showing.
 * @returns the current value, or `undefined` when there is none.
 */
export function useActivity(store: ActivityStore, sessionId: string | undefined): ActivityView | undefined {
  const subscribe = React.useCallback((listener: () => void) => store.subscribe(listener), [store])
  const read = React.useCallback(() => store.get(sessionId), [store, sessionId])
  return React.useSyncExternalStore(subscribe, read)
}

/**
 * Seed one session's value from the registry's current snapshot.
 *
 * A value only *arrives* when it changes, so a session opened after its last
 * change — a resume, or a window reattached to a running agent — would show
 * nothing until the next event without this read.
 * @param registry - Host projection registry.
 * @param store - Store to fill.
 * @param session - Session to read.
 */
export function seedActivity(
  registry: ProjectionRegistryLike | undefined,
  store: ActivityStore,
  session: unknown,
): void {
  if (registry === undefined || session === null || session === undefined) return
  const id = String((session as { id: unknown }).id)
  try {
    const snapshot = registry.snapshot(session, [ACTIVITY_PROJECTION_KEY])
    const view = asActivityView(snapshot.values[ACTIVITY_PROJECTION_KEY])
    if (view === undefined) store.clear(id)
    else {
      store.remember(id, session)
      store.update(id, view)
    }
    store.noteReadSuccess(id)
  } catch (error) {
    // An unreadable snapshot is still not worth failing a session bind over,
    // but it is no longer silent either: warn once per session, and a read
    // that keeps failing eventually drops the value so the tick disarms.
    store.noteReadFailure(id, error instanceof Error ? error.message : String(error))
  }
}
