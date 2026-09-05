/** One owner for synchronous versions and frame-coalesced renderer wakeups. */
import { swallowNestedUpdateOverflow } from '../../ink/update-overflow-guard.js'
import { foldRows, MAX_ROWS } from './transcript.js'
import type { ChannelState } from './types.js'

export function createChannelEmitter(
  getState: () => Pick<ChannelState, 'rows' | 'version'>,
  /** Returns true when the deferred projector changed renderer-visible data. */
  beforeStream: () => boolean,
) {
  const listeners = new Set<() => void>()
  const foldCursor = { rows: undefined as unknown, index: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const wake = (source: string) => {
    const state = getState()
    // Folding mutates retained transcript rows after a reader may have
    // cached the ingress revision. Publish that completed fold separately so
    // listeners cannot observe a stale or mixed same-version snapshot.
    if (foldRows(state.rows, MAX_ROWS, foldCursor) > 0) state.version += 1
    for (const listener of listeners) {
      try { listener() } catch (error) {
        if (!swallowNestedUpdateOverflow(error, source)) throw error
      }
    }
  }
  return {
    subscribe(listener: () => void) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit() {
      if (disposed) return
      getState().version += 1
      wake('channel.emit')
    },
    emitStream() {
      if (disposed) return
      getState().version += 1
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        if (disposed) return
        // emitStream bumps on ingress so ordinary stream state is observable
        // immediately. A deferred projector can then publish its completed
        // snapshot as a distinct revision, preventing a pre-flush read from
        // surviving the wakeup with stale rows.
        if (beforeStream()) getState().version += 1
        wake('channel.emitStream')
      }, 16)
      timer.unref()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      listeners.clear()
    },
  }
}
