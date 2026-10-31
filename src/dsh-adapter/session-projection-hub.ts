/**
 * Plugin projection watches, folded for the session on screen: one store per
 * projection key, shared by every watcher of that key
 * (`ctx.tuiSessionData.watchProjection`, see `session-data.ts`).
 *
 * Each key reuses {@link createSessionProjectionStore} with an identity
 * narrow — the value is the plugin's own wire value, narrowed by the plugin —
 * so a watch inherits its whole lifecycle: a baseline read when a session
 * binds, the old value cleared first when `/new`, `/resume` or a rewind binds
 * another one, background sessions' pushes dropped, the value reference kept
 * while the host keeps it.
 *
 * The hub is scoped to the composition root because its two halves arrive
 * from different rows in no fixed order: the channel's DSH bind seeds it
 * (`seedProjections`, beside the team and occupancy seeds — the runtime row
 * imports lazily), and the session-data service on the extensions row wires
 * it to the host registry ({@link SessionProjectionHub.connect}). Either may
 * come first; a store created after the bind seeds at once from the last
 * bound session.
 *
 * Cost stays bounded by what is watched, not by the session count: a store
 * exists only while a watcher holds its key and keeps only the bound
 * session's value, and every store rides ONE change-feed listener per
 * attached registry, dispatched by key.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionRegistryLike } from './activity-store.js'
import { compositionRoot } from './host-access.js'
import { createSessionProjectionStore, type SessionProjectionStore } from './session-projection-store.js'

/** One watcher's hold on a shared key. */
export interface SessionProjectionLease {
  readonly key: string
  /** The bound session's id, once a session bound; `undefined` after an unbind or release. */
  readonly sessionId: string | undefined
  /** The bound session's raw value; `undefined` after an unbind or release. */
  read(): unknown
  /**
   * Notified when the value or the bound session changes (never twice for the
   * same pair). A throwing listener is reported and skipped; the others run.
   */
  subscribe(listener: () => void): () => void
  /** Drop the hold; the last one drops the key's store. Idempotent. */
  release(): void
}

export interface SessionProjectionHub {
  /** Bind the session on screen and read every held key's baseline. */
  seed(session: unknown): void
  /**
   * Forget the bound session: the channel that seeded it ended. Every lease
   * reads no session and no value (and is notified) until the next seed.
   */
  unbind(): void
  /** Hold `key`, creating (and seeding) its store for the first holder. */
  acquire(key: string, onListenerError?: (error: unknown) => void): SessionProjectionLease
  /** Whether a store for `key` exists (some watcher holds it). */
  has(key: string): boolean
  /** Distinct keys held. */
  readonly size: number
  /** The bound session's id, once a session bound. */
  readonly boundId: string | undefined
  /** Read every held key's baseline again (a projection definition came or left). */
  reseed(): void
  /**
   * Wire the hub to the host registry on `ctx`'s fiber: the registry's
   * arrival seeds every store, its departure clears them, and a profile write
   * reads them again. Owned by that fiber.
   */
  connect(ctx: Context): void
}

interface Entry {
  readonly store: SessionProjectionStore<unknown>
  refs: number
}

function sessionIdOf(session: unknown): string {
  return String((session as { id: unknown }).id)
}

/**
 * Create a hub. The composition root holds one ({@link sessionProjectionHubFor});
 * a direct call is for host code and regressions that own their own scope.
 * @param options - Optional read-failure sink, until {@link SessionProjectionHub.connect}
 *   points it at the connecting fiber's logger.
 * @returns the hub.
 */
export function createSessionProjectionHub(options: { warn?(message: string): void } = {}): SessionProjectionHub {
  const entries = new Map<string, Entry>()
  const bindListeners = new Set<() => void>()
  let registry: ProjectionRegistryLike | undefined
  let bound: unknown
  let warn = options.warn
  const report = (message: string): void => {
    try {
      warn?.(message)
    } catch {
      // A diagnostics sink must not break a read.
    }
  }

  const attach = (next: ProjectionRegistryLike): void => {
    registry = next
    for (const { store } of [...entries.values()]) store.attachRegistry(next)
  }
  const detach = (left: ProjectionRegistryLike): void => {
    if (registry === left) registry = undefined
    for (const { store } of [...entries.values()]) store.detachRegistry(left)
  }

  const hub: SessionProjectionHub = {
    seed(session) {
      if (session === null || session === undefined) return
      const changed = bound === undefined || sessionIdOf(bound) !== sessionIdOf(session)
      bound = session
      for (const { store } of [...entries.values()]) store.seed(session)
      if (!changed) return
      for (const listener of [...bindListeners]) listener()
    },
    unbind() {
      if (bound === undefined) return
      bound = undefined
      for (const { store } of [...entries.values()]) store.unbind()
      for (const listener of [...bindListeners]) listener()
    },
    acquire(key, onListenerError) {
      let entry = entries.get(key)
      if (entry === undefined) {
        const store = createSessionProjectionStore<unknown>({
          key,
          // The plugin narrows its own wire value; the host only keeps it.
          narrow: value => value,
          warn: report,
        })
        if (registry !== undefined) store.attachRegistry(registry)
        if (bound !== undefined) store.seed(bound)
        entry = { store, refs: 0 }
        entries.set(key, entry)
      }
      entry.refs += 1
      const held = entry
      const listeners = new Set<() => void>()
      let released = false
      // The pair last delivered: the store also emits on a reseed that read
      // the same reference, and a bind may change the id with no value.
      let lastValue = held.store.read()
      let lastSession = held.store.boundId
      const forward = (): void => {
        if (released) return
        const value = held.store.read()
        const sessionId = held.store.boundId
        if (value === lastValue && sessionId === lastSession) return
        lastValue = value
        lastSession = sessionId
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            try {
              onListenerError?.(error)
            } catch {
              // The error sink is advisory.
            }
          }
        }
      }
      const offStore = held.store.subscribe(forward)
      bindListeners.add(forward)
      return {
        key,
        get sessionId() {
          return released ? undefined : held.store.boundId
        },
        read: () => (released ? undefined : held.store.read()),
        subscribe(listener) {
          if (released || typeof listener !== 'function') return () => {}
          // Each subscription is its own entry, so the same function
          // subscribed twice is unsubscribed one at a time.
          const own = (): void => { listener() }
          listeners.add(own)
          return () => { listeners.delete(own) }
        },
        release() {
          if (released) return
          released = true
          listeners.clear()
          offStore()
          bindListeners.delete(forward)
          held.refs -= 1
          if (held.refs === 0 && entries.get(key) === held) entries.delete(key)
        },
      }
    },
    has: key => entries.has(key),
    get size() {
      return entries.size
    },
    get boundId() {
      return bound === undefined ? undefined : sessionIdOf(bound)
    },
    reseed() {
      for (const { store } of [...entries.values()]) store.reseed()
    },
    connect(ctx) {
      warn = message => { ctx.logger.warn(message) }
      ctx.inject(['sessionProjections'] as never, ((projectionCtx: Context) => {
        const next = (projectionCtx as unknown as { sessionProjections?: ProjectionRegistryLike }).sessionProjections
        if (next === undefined) return
        attach(next)
        let offFeed: (() => void) | undefined
        try {
          // ONE listener for every held key: a key nobody holds is a map miss.
          offFeed = next.onChanged((session, key, value) => {
            entries.get(key)?.store.update(sessionIdOf(session), value)
          })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          report(`dsh-tui: session-data projection feed failed: ${detail}`)
        }
        // On the injected fiber: a re-provided registry re-runs this callback
        // and must not stack feed listeners.
        projectionCtx.effect(() => () => {
          offFeed?.()
          detach(next)
        }, 'dsh-tui session-data projection feed')
      }) as never)
      // Registering or unregistering a projection unit emits nothing on the
      // change feed; the plugin manager announces every profile write it
      // applied, so the held keys are read again (a unit that left reads
      // absent, one that came reads its value from the bound session's log).
      ctx.on('plugin-manager/changed', () => { hub.reseed() })
    },
  }
  return hub
}

const hubs = new WeakMap<object, SessionProjectionHub>()

function rootKey(ctx: Context): object {
  try {
    return compositionRoot(ctx) as object
  } catch {
    // A minimal embedder without fiber reflection is its own scope.
    return ctx as object
  }
}

/**
 * The composition root's hub, created on first use by whichever half arrives
 * first (the channel's seed or the session-data service).
 * @param ctx - Any context of the composition.
 * @returns the hub shared by that composition.
 */
export function sessionProjectionHubFor(ctx: Context): SessionProjectionHub {
  const key = rootKey(ctx)
  let hub = hubs.get(key)
  if (hub === undefined) {
    hub = createSessionProjectionHub()
    hubs.set(key, hub)
  }
  return hub
}
