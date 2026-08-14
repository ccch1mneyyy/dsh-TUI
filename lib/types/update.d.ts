export interface TuiUpdateInfo {
    current: string;
    latest: string;
}
export interface TuiUpdateResult {
    /** Exit code of the `dsh plugin update` run (0 = the package was updated). */
    updateCode: number;
    /**
     * Exit code of the restarted TUI process. Equals `updateCode` when the
     * failure happened before a restart was attempted.
     */
    restartCode: number;
}
/** Read the version from either the compiled package or the source checkout. */
export declare function installedTuiVersion(): string | undefined;
/**
 * Resolve the registry base URL the way npm/pnpm would: `NPM_CONFIG_REGISTRY`
 * (both spellings) over the `registry=` line in ~/.npmrc over npmjs.org, so
 * mirror users see the same `latest` their package manager would install.
 */
export declare function resolveRegistryBase(): string;
/** True when `current` is a strictly newer valid version than `previous`. */
export declare function isVersionNewer(current: string, previous: string): boolean;
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
 * `--latest` is required: `pnpm add` writes a caret range into the profile
 * manifest, and a plain `pnpm update` stays inside that range — with this
 * project's minor-per-release cadence the TUI would restart unchanged while
 * reporting success. The restart carries `DSH_CC_UPDATED_FROM` so the new
 * process can warn when the version did not actually move (e.g. a mirror
 * registry still serving the old `latest`).
 *
 * @param sessionId - Session to resume in the replacement process.
 * @returns Exit codes for the update run and the replacement process.
 */
export declare function updateTuiAndRestart(sessionId: string): Promise<TuiUpdateResult>;
//# sourceMappingURL=update.d.ts.map