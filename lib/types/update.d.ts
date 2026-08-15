import { shellQuote } from './utils/shellQuote.js';
export { shellQuote };
export interface TuiUpdateInfo {
    current: string;
    latest: string;
}
/** What a fresh registry lookup says about this install. */
export type TuiUpdateTarget = {
    kind: 'update';
    current: string;
    latest: string;
} | {
    kind: 'latest';
    current: string;
} | {
    kind: 'unknown';
};
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
 * The profile this TUI was booted with (`dsh --profile <name>`), read from
 * the launcher argv the process inherited. dsh sets no profile env var, and
 * its launcher parses its own flags first, so the first `--profile` token in
 * argv is the launcher's. Undefined for non-profile launches (source
 * checkouts, `--config` overlays) — there is no profile installation for
 * `/update` to act on, so the command must stay disabled there.
 */
export declare function resolveDshProfileName(argv?: readonly string[]): string | undefined;
/**
 * Resolve the registry base URL the way npm/pnpm would: `NPM_CONFIG_REGISTRY`
 * (both spellings) over the `registry=` line in ~/.npmrc over npmjs.org, so
 * mirror users see the same `latest` their package manager would install.
 */
export declare function resolveRegistryBase(): string;
/** True when `current` is a strictly newer valid version than `previous`. */
export declare function isVersionNewer(current: string, previous: string): boolean;
/**
 * Classify this install against a fresh registry lookup: an update is
 * available, the install is already latest, or the answer is unknown
 * (offline / registry error / unreadable own version).
 */
export declare function resolveTuiUpdateTarget(): Promise<TuiUpdateTarget>;
/**
 * Check npm for a newer published TUI version. Network and registry errors
 * are intentionally treated as "no result" so an offline launch never delays
 * or blocks the interactive TUI.
 */
export declare function checkForTuiUpdate(): Promise<TuiUpdateInfo | undefined>;
/**
 * Update the installed dsh-tui package and restart the same launcher while
 * preserving the active session. The TUI must already be unmounted before
 * this is called so pnpm output cannot corrupt the rendered terminal frame.
 *
 * `--latest` is required: `pnpm add` writes a caret range into the profile
 * manifest, and a plain `pnpm update` stays inside that range — with this
 * project's minor-per-release cadence the TUI would restart unchanged while
 * reporting success. The restart carries `DSH_TUI_UPDATED_FROM` so the new
 * process can warn when the version did not actually move (e.g. a mirror
 * registry still serving the old `latest`).
 *
 * @param sessionId - Session to resume in the replacement process.
 * @param profile - The dsh profile this TUI was launched with; updating any
 *   other profile would leave the running install untouched.
 * @returns Exit codes for the update run and the replacement process.
 */
export declare function updateTuiAndRestart(sessionId: string, profile: string): Promise<TuiUpdateResult>;
//# sourceMappingURL=update.d.ts.map