/**
 * Data-directory paths for the dsh-tui profile, renamed from `~/.dsh-cc` to
 * `~/.dsh-tui` (issue #120). On first launch the legacy directory is COPIED
 * (not moved) to the new location; afterwards only the new directory is read
 * and written. The one exception is `resume.txt`, which sessionHistory
 * dual-writes for old launchers — see the launcher contract there.
 *
 * The compiled copy (lib/types/utils/paths.js) is also imported by the bin
 * launcher, mirroring the shellQuote precedent.
 */
/**
 * The user's home directory. `os.homedir()` first; the USERPROFILE/HOME
 * spellings are the last-resort fallback for stripped-down environments.
 * @returns Absolute home path.
 */
export declare function homeDir(): string;
/** Data directory all preferences/history live in (`~/.dsh-tui`). */
export declare const DATA_DIR: string;
/** Pre-rename data directory (`~/.dsh-cc`), read only for migration. */
export declare const LEGACY_DATA_DIR: string;
/**
 * Copy the legacy data directory to the new location on first launch.
 * A copy (not a move) so old launchers keep working and the user can delete
 * the legacy directory themselves once satisfied. No-op when the legacy
 * directory is absent or the new one already exists.
 * @param legacy - Legacy directory (injectable for tests).
 * @param target - New directory (injectable for tests).
 * @returns True when a migration copy happened.
 */
export declare function migrateLegacyDataDir(legacy?: string, target?: string): boolean;
/**
 * Env vars renamed in issue #120 that no longer take effect: old name → new
 * name. `DSH_CC_RESUME_SESSION` is deliberately absent — it remains a valid
 * half of the dual-read launcher contract (see sessionHistory.ts).
 */
export declare const RENAMED_ENV: Readonly<Record<string, string>>;
/**
 * Old env-var names still set in the environment (they no longer take
 * effect). Used to print one deprecation line per name before the TUI
 * renders — stderr writes break the fullscreen UI once it is up.
 * @param env - Environment to scan (defaults to process.env; injectable).
 * @returns The legacy names found, in RENAMED_ENV order.
 */
export declare function detectLegacyEnv(env?: NodeJS.ProcessEnv): string[];
//# sourceMappingURL=paths.d.ts.map