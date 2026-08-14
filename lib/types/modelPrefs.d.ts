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
/** A complete request route: both halves always from the same source. */
export interface ModelRoute {
    provider: string;
    model: string;
}
/**
 * The harness default route: the adapter the bundled deployment ships with.
 * Lives in code, not in cordis.patch.yml — a config key expresses a
 * deployment DECISION, never a default, so the "default" branch of the
 * precedence below stays reachable in shipped compositions (issue #67).
 */
export declare const DEFAULT_MODEL_ROUTE: ModelRoute;
/**
 * Atomically resolve the request route from the three candidate sources.
 * A route is ONE decision, not two: `provider` and `model` always leave
 * this function from the same source, so a mixed route such as
 * `deepseek-official` + `glm-5.3` (issue #67) cannot be constructed.
 *
 * Precedence:
 * 1. `configured` wins only when BOTH halves are explicitly set — a
 *    deployment override must be a complete route. A half-written config
 *    is ignored entirely (falling through), never merged half-way.
 * 2. Otherwise the persisted `/model` choice wins as a whole.
 * 3. Otherwise per-half fallback to the harness defaults.
 *
 * @param configured - Explicit cordis.yml `provider`/`model` keys (either
 *   may be undefined; both set means a deliberate deployment override).
 * @param pref - The persisted `/model` choice, if any.
 * @param fallback - Route used when neither source applies (defaults to
 *   {@link DEFAULT_MODEL_ROUTE}); each half still honors a configured
 *   half, so a lone `provider:` pins the provider only in the no-pref
 *   branch.
 * @returns The route plus which source it came from.
 */
export declare function resolveModelRoute(configured: {
    provider?: string;
    model?: string;
}, pref: ModelPref | undefined, fallback?: ModelRoute): {
    route: ModelRoute;
    source: 'config' | 'pref' | 'default';
};
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
//# sourceMappingURL=modelPrefs.d.ts.map