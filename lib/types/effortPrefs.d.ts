/**
 * Persisted reasoning-effort preference (`~/.dsh-tui/effort.json`). Shift+Tab
 * cycles the live route's adapter-owned levels (dsh-llm `LlmModelReasoningInfo`);
 * the choice lands here so the next boot starts on it. The file is
 * best-effort: a missing/corrupt file or a level the current adapter does not
 * offer just falls back to the provider default — the first request/header
 * event always re-asserts the truth on the status line.
 */
/**
 * The persisted reasoning-effort id, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted effort id, if any.
 */
export declare function readEffortPref(dir?: string): string | undefined;
/**
 * Persist the chosen reasoning-effort id (best effort).
 * @param effort - Adapter-owned effort id to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export declare function writeEffortPref(effort: string, dir?: string): boolean;
//# sourceMappingURL=effortPrefs.d.ts.map