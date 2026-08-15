/**
 * Persisted agent-preset preference (`/preset` picker choice), kept at
 * `~/.dsh-tui/agent-preset.json` (`preset` key) so the choice survives
 * restarts — same pattern as working-activity.json. The file is best-effort:
 * a missing/corrupt file or an id the roster no longer supplies simply falls
 * back to the roster default (`standard`). An explicit `preset` key in
 * cordis.yml wins over this preference (deployment choice over runtime
 * preference, matching activityFrames).
 */
/**
 * Parse a persisted `{ preset }` value; anything else yields undefined.
 * @param text - Raw file contents.
 * @returns The preset id when valid, else undefined.
 */
export declare function parsePresetPref(text: string): string | undefined;
/**
 * The persisted preset id, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted preset id, if any.
 */
export declare function readPresetPref(dir?: string): string | undefined;
/**
 * Persist the chosen preset id (best effort).
 * @param preset - Preset id to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export declare function writePresetPref(preset: string, dir?: string): boolean;
//# sourceMappingURL=presetPrefs.d.ts.map