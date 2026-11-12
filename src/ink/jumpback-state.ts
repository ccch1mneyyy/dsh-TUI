/**
 * Jump-back identity for this process: whether the user opted into pane
 * jump-back, and the marker that names this pane.
 *
 * The marker is published here instead of being derived by each consumer.
 * The pane-title writer, the pre-toast probe and the documented JSON contract
 * all read this one value, so the title and the activation URI can never
 * disagree about who this pane is. It is minted on the first enable
 * and kept for the rest of the process, which is the stability the title
 * contract asks for.
 */
import { randomBytes } from 'node:crypto'

/** Published jump-back state; the object identity changes only when the state does. */
export interface JumpBackState {
  /** True when the user opted into jump-back. Consumers gate every effect on it. */
  readonly enabled: boolean
  /** 16 lowercase hex characters naming this pane; null until the first enable. */
  readonly marker: string | null
  /**
   * The enable generation. Every enable or disable publishes a new value, so an
   * asynchronous preparation that started under an older generation can tell it
   * has been superseded before it reaches the registry.
   */
  readonly generation: number
}

let state: JumpBackState = { enabled: false, marker: null, generation: 0 }
const subscribers: Set<() => void> = new Set()

/**
 * The current jump-back state, for `useSyncExternalStore` and for consumers
 * that need the marker.
 * @returns the published state; the same object until the state changes.
 */
export function getJumpBackState(): JumpBackState {
  return state
}

/**
 * Subscribe to jump-back state changes, for `useSyncExternalStore`.
 * @param cb - invoked synchronously after every published change.
 * @returns a function that unsubscribes the callback.
 */
export function subscribeJumpBack(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Publish the user's jump-back choice. Enabling mints the marker once and
 * keeps it afterwards, so toggling the setting cannot change an identity that
 * a documented JSON file or an already-delivered toast refers to.
 * @param enabled - the resolved `jumpBack` setting.
 */
export function setJumpBackEnabled(enabled: boolean): void {
  if (enabled === state.enabled) return
  state = {
    enabled,
    marker: enabled && state.marker === null ? randomBytes(8).toString('hex') : state.marker,
    generation: state.generation + 1,
  }
  for (const cb of subscribers) {
    cb()
  }
}
