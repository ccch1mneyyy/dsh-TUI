/** One owner for synchronous versions and frame-coalesced renderer wakeups. */
import { swallowNestedUpdateOverflow } from '../../ink/update-overflow-guard.js'
import { foldRows, MAX_ROWS } from './transcript.js'
import type { ChannelState } from './types.js'

export function createChannelEmitter(
  getState: () => Pick<ChannelState, 'rows' | 'version'>,
  beforeStream: () => void,
) {
  const listeners = new Set<() => void>()
  const foldCursor = { rows: undefined as unknown, index: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const wake = (source: string) => {
    const state = getState()
    foldRows(state.rows, MAX_ROWS, foldCursor)
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
        beforeStream()
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
