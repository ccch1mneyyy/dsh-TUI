export interface TuiUpdateInfo {
    current: string;
    latest: string;
}
/**
 * Check npm for a newer published TUI version.
 *
 * Network and registry errors are intentionally treated as "no result" so an
 * offline launch never delays or blocks the interactive TUI.
 */
export declare function checkForTuiUpdate(): Promise<TuiUpdateInfo | undefined>;
/**
 * Update the installed cc-tui package and restart the same launcher while
 * preserving the active session. The TUI must already be unmounted before
 * this is called so pnpm output cannot corrupt the rendered terminal frame.
 *
 * @param sessionId - Session to resume in the replacement process.
 * @returns The replacement process exit code.
 */
export declare function updateTuiAndRestart(sessionId: string): Promise<number>;
//# sourceMappingURL=update.d.ts.map