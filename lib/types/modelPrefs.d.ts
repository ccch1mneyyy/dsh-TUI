/**
 * Persisted model-route preference (`/model` picker choice), kept at
 * `~/.dsh-cc/model.json` (`provider` + `model` keys) so the choice survives
 * restarts — same pattern as agent-preset.json. The file is best-effort: a
 * missing/corrupt file or an incomplete route simply falls back to the
 * harness default. Explicit `provider`/`model` keys in cordis.yml win over
 * this preference (deployment choice over runtime preference, matching
 * activityFrames and agent-preset).
 */
/** One persisted model route: the provider route plus its model id. */
export interface ModelPref {
    provider: string;
    model: string;
}
/**
 * Parse a persisted `{ provider, model }` value; anything else yields
 * undefined.
 * @param text - Raw file contents.
 * @returns The route when both halves are non-empty strings, else undefined.
 */
export declare function parseModelPref(text: string): ModelPref | undefined;
/**
 * The persisted model route, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted route, if any.
 */
export declare function readModelPref(dir?: string): ModelPref | undefined;
/**
 * Persist the chosen model route (best effort).
 * @param provider - Provider route to persist.
 * @param model - Provider-owned model id to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export declare function writeModelPref(provider: string, model: string, dir?: string): boolean;
