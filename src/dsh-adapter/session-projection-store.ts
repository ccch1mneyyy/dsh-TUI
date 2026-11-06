/**
 * One host session-projection key, folded for the session on screen.
 *
 * The host projection feed is process-wide and carries whole values, so a
 * read side needs the same three pieces every time: drop other keys, narrow
 * the wire value with a local guard (the producer package is never imported),
 * and read one baseline snapshot when a session binds — a value is only
 * published on change, so a resumed session would otherwise wait for its next
 * event. The store keeps only the watched session's value: a background
 * session must not overwrite what the screen shows.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionRegistryLike } from './activity-store.js'

/** The session whose projection value the session on screen shows. */
export interface WatchedSession {
  readonly id: string
  /** The live session object, when there is one to read a baseline from. */
  readonly session?: unknown
}

export interface SessionProjectionStoreOptions<T> {
  /** Projection key the value is published under. */
  readonly key: string
  /** Narrow one wire value of a session; anything else is dropped, never half-rendered. */
  narrow(value: unknown, sessionId: string): T | undefined
  /** Map the bound session to the session it reads (default: itself). */
  watch?(session: unknown): WatchedSession
  /** Read-failure sink, reported once per attached registry (the composition root's logger). */
  warn?(message: string): void
}

export interface SessionProjectionStore<T> {
  /** Remember the host registry; a late registry seeds the bound session. */
  attachRegistry(registry: ProjectionRegistryLike): void
  /** Forget a registry that left; nothing is read from it again and the value clears. */
  detachRegistry(registry: ProjectionRegistryLike): void
  /** Bind the session on screen and read its watched value once. */
  seed(session: unknown): void
  /** Forget the bound session (the channel that bound it ended); the value clears. */
  unbind(): void
  /** Record one value from the change feed. */
  update(sessionId: string, value: unknown): void
  /**
   * Read the bound session's baseline again. For a change the feed does not
   * carry: a projection definition that left (its key reads as absent) or
   * came back.
   */
  reseed(): void
  /** The bound session's id, once a session bound. */
  readonly boundId: string | undefined
  /** The watched session's id, once a session bound. */
  readonly watchedId: string | undefined
  /** The watched session's current value, stable between updates. */
  read(): T | undefined
  subscribe(listener: () => void): () => void
  noteReadFailure(error: unknown): void
}

/** A raw value no snapshot can return: the next update always narrows. */
const UNREAD: unique symbol = Symbol('unread')

function sessionIdOf(session: unknown): string {
  return String((session as { id: unknown }).id)
}

export function createSessionProjectionStore<T>(options: SessionProjectionStoreOptions<T>): SessionProjectionStore<T> {
  const listeners = new Set<() => void>()
  let registry: ProjectionRegistryLike | undefined
  let bound: unknown
  let watched: WatchedSession | undefined
  let raw: unknown
  let value: T | undefined
  let warned = false
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const store: SessionProjectionStore<T> = {
    attachRegistry(next) {
      registry = next
      warned = false
      if (bound !== undefined) store.seed(bound)
    },
    detachRegistry(left) {
      if (registry !== left) return
      registry = undefined
      raw = undefined
      if (value === undefined) return
      value = undefined
      emit()
    },
    seed(session) {
      if (session === null || session === undefined) return
      bound = session
      const next = options.watch?.(session) ?? { id: sessionIdOf(session), session }
      if (next.id !== watched?.id) {
        raw = undefined
        if (value !== undefined) {
          value = undefined
          emit()
        }
      }
      watched = next
      if (registry === undefined || next.session === undefined) return
      try {
        store.update(next.id, registry.snapshot(next.session, [options.key]).values[options.key])
      } catch (error) {
        store.noteReadFailure(error)
      }
    },
    unbind() {
      bound = undefined
      watched = undefined
      raw = undefined
      if (value === undefined) return
      value = undefined
      emit()
    },
    update(sessionId, next) {
      if (sessionId !== watched?.id) return
      // The host reuses the value reference while its state is unchanged, so
      // identity is the whole change test.
      if (next === raw) return
      raw = next
      const narrowed = options.narrow(next, sessionId)
      if (narrowed === undefined && value === undefined) return
      value = narrowed
      emit()
    },
    reseed() {
      if (bound === undefined) return
      // The narrow may read host state the value reference does not track
      // (the team's service presence), so an unchanged value, an absent one
      // included, is re-narrowed.
      const held = raw
      raw = UNREAD
      store.seed(bound)
      // No snapshot was read (no registry, the watched session not live, or a
      // failed read): narrow the value already held instead.
      if (raw === UNREAD && held !== UNREAD && watched !== undefined) store.update(watched.id, held)
    },
    get boundId() {
      return bound === undefined ? undefined : sessionIdOf(bound)
    },
    get watchedId() {
      return watched?.id
    },
    read: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    noteReadFailure(error) {
      if (warned) return
      warned = true
      const detail = error instanceof Error ? error.message : String(error)
      options.warn?.(`dsh-tui: ${options.key} projection read failed: ${detail}`)
    },
  }
  return store
}

/**
 * Wire one store to the host's projection registry once it exists. The
 * registry and the unit that publishes the key are mounted by other plugins,
 * so both may arrive later — or never, which leaves the store empty.
 * @param ctx - Host context of the composition root.
 * @param key - Projection key the store folds.
 * @param store - Store to fill.
 */
export function attachSessionProjection(ctx: Context, key: string, store: SessionProjectionStore<unknown>): void {
  ctx.inject(['sessionProjections'] as never, ((projectionCtx: Context) => {
    const registry = (projectionCtx as unknown as { sessionProjections?: ProjectionRegistryLike }).sessionProjections
    if (registry === undefined) return
    store.attachRegistry(registry)
    let offFeed: (() => void) | undefined
    try {
      offFeed = registry.onChanged((session, changed, value) => {
        if (changed === key) store.update(sessionIdOf(session), value)
      })
    } catch (error) {
      store.noteReadFailure(error)
    }
    // On the injected fiber: a re-provided registry re-runs this callback.
    projectionCtx.effect(() => () => {
      offFeed?.()
      store.detachRegistry(registry)
    }, `dsh-tui ${key} projection feed`)
  }) as never)
}
