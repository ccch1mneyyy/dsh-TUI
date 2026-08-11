/**
 * Terminal focus state, driven by DECSET 1004 focus events. 'unknown' is
 * the default for terminals that don't support focus reporting; consumers
 * treat 'unknown' identically to 'focused' (no throttling).
 */
export type TerminalFocusState = 'focused' | 'blurred' | 'unknown'

let focusState: TerminalFocusState = 'unknown'
const resolvers: Set<() => void> = new Set()
const subscribers: Set<() => void> = new Set()

/**
 * Record a terminal focus change and notify subscribers synchronously.
 * A blur also resolves pending focus waiters.
 * @param v - true when the terminal gained focus, false when it blurred.
 */
export function setTerminalFocused(v: boolean): void {
  focusState = v ? 'focused' : 'blurred'
  // Notify useSyncExternalStore subscribers
  for (const cb of subscribers) {
    cb()
  }
  if (!v) {
    for (const resolve of resolvers) {
      resolve()
    }
    resolvers.clear()
  }
}

/**
 * Whether the terminal is currently considered focused. 'unknown' counts
 * as focused so terminals without focus reporting never appear blurred.
 * @returns true unless the terminal is known to be blurred.
 */
export function getTerminalFocused(): boolean {
  return focusState !== 'blurred'
}

/**
 * The current terminal focus state ('focused' | 'blurred' | 'unknown').
 * @returns the current focus state.
 */
export function getTerminalFocusState(): TerminalFocusState {
  return focusState
}

/**
 * Subscribe to focus-change notifications, for useSyncExternalStore.
 * @param cb - callback invoked synchronously on every focus change.
 * @returns a function that unsubscribes the callback.
 */
export function subscribeTerminalFocus(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Reset the focus state to 'unknown' and notify subscribers. Used when
 * focus reporting is (re)initialized.
 */
export function resetTerminalFocusState(): void {
  focusState = 'unknown'
  for (const cb of subscribers) {
    cb()
  }
}
