/**
 * The kind of tab-status indicator: 'idle', 'busy', or 'waiting'.
 */
export type TabStatusKind = 'idle' | 'busy' | 'waiting';
/**
 * Declaratively set the tab-status indicator (OSC 21337).
 *
 * Emits a colored dot + short status text to the tab sidebar. Terminals
 * that don't support OSC 21337 discard the sequence silently, so this is
 * safe to call unconditionally. Wrapped for tmux/screen passthrough.
 *
 * Pass `null` to opt out. If a status was previously set, transitioning to
 * `null` emits CLEAR_TAB_STATUS so toggling off mid-session doesn't leave
 * a stale dot. Process-exit cleanup is handled by ink.tsx's unmount path.
 * @param kind - the status kind to display, or null to opt out.
 */
export declare function useTabStatus(kind: TabStatusKind | null): void;
//# sourceMappingURL=use-tab-status.d.ts.map