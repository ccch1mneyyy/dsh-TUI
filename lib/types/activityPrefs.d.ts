/**
 * Persisted working-activity indicator preference, mirroring the pi
 * working-activity extension's `~/.pi/agent/working-activity.json`
 * (`frames` key). dsh-tui keeps its own copy at
 * `~/.dsh-tui/working-activity.json` so the `/activity` choice survives
 * restarts. The file is best-effort: a missing or corrupt file (or an
 * unknown preset left behind by an older version) just falls back to the
 * default preset.
 */
/**
 * Parse a persisted `{ frames }` value; anything else yields undefined.
 * @param text - Raw file contents.
 * @returns The preset name when valid, else undefined.
 */
export declare function parseActivityFrames(text: string): string | undefined;
/**
 * The persisted indicator preset name, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted preset name, if any.
 */
export declare function readActivityFrames(dir?: string): string | undefined;
/**
 * Persist the chosen indicator preset (best effort).
 * @param name - Preset name to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export declare function writeActivityFrames(name: string, dir?: string): boolean;
//# sourceMappingURL=activityPrefs.d.ts.map