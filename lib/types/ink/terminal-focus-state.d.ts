/**
 * Terminal focus state, driven by DECSET 1004 focus events. 'unknown' is
 * the default for terminals that don't support focus reporting; consumers
 * treat 'unknown' identically to 'focused' (no throttling).
 */
export type TerminalFocusState = 'focused' | 'blurred' | 'unknown';
/**
 * Record a terminal focus change and notify subscribers synchronously.
 * A blur also resolves pending focus waiters.
 * @param v - true when the terminal gained focus, false when it blurred.
 */
export declare function setTerminalFocused(v: boolean): void;
/**
 * Whether the terminal is currently considered focused. 'unknown' counts
 * as focused so terminals without focus reporting never appear blurred.
 * @returns true unless the terminal is known to be blurred.
 */
export declare function getTerminalFocused(): boolean;
/**
 * The current terminal focus state ('focused' | 'blurred' | 'unknown').
 * @returns the current focus state.
 */
export declare function getTerminalFocusState(): TerminalFocusState;
/**
 * Subscribe to focus-change notifications, for useSyncExternalStore.
 * @param cb - callback invoked synchronously on every focus change.
 * @returns a function that unsubscribes the callback.
 */
export declare function subscribeTerminalFocus(cb: () => void): () => void;
/**
 * Reset the focus state to 'unknown' and notify subscribers. Used when
 * focus reporting is (re)initialized.
 */
export declare function resetTerminalFocusState(): void;
//# sourceMappingURL=terminal-focus-state.d.ts.map