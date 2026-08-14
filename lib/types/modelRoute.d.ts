/**
 * Model route resolution (issue #67). The `(provider, model)` pair is a
 * single value: every source either supplies the WHOLE route or is skipped,
 * so a cordis.yml `provider`-only pin (the bundle ships
 * `provider: deepseek-official` without `model`) can never merge with the
 * model half of the persisted `/model` choice into a route no adapter
 * recognizes. Startup, `/new`, resume and the status line all resolve through
 * these helpers so the displayed route is the route requests actually take.
 */
import type { ModelPref } from './modelPrefs.js';
/** One complete model route. */
export interface ModelRoute {
    provider: string;
    model: string;
}
/** Harness default route: the final fallback when neither cordis.yml nor the persisted `/model` choice supplies one. */
export declare const DEFAULT_MODEL_ROUTE: ModelRoute;
/**
 * The route cordis.yml pins explicitly — only when it names BOTH halves. A
 * half-pinned config counts as unset here so it cannot override half of the
 * persisted preference (issue #67).
 * @param configured - Raw `provider`/`model` keys from cordis.yml.
 * @returns The configured route, or undefined when either half is missing.
 */
export declare function explicitModelRoute(configured: {
    provider?: string;
    model?: string;
}): ModelRoute | undefined;
/**
 * Resolve the effective route atomically: a complete cordis.yml route wins
 * whole; otherwise the persisted `/model` choice wins whole; otherwise the
 * defaults win whole — a half-pinned config is IGNORED rather than merged
 * with the defaults' other half, so no source ever contributes just one
 * half of the final route.
 * @param configured - Raw `provider`/`model` keys from cordis.yml.
 * @param pref - The persisted `/model` choice, if any.
 * @param defaults - Final fallback route (the channel's startup route for
 *   `/new`, the harness default at boot).
 * @returns The resolved route.
 */
export declare function resolveModelRoute(configured: {
    provider?: string;
    model?: string;
}, pref: ModelPref | undefined, defaults?: ModelRoute): ModelRoute;
/**
 * The route a persisted session's own log records (issues #30/#67): the last
 * `request/header` snapshot carries the call config the agent loop builds its
 * requests from, so it IS the route a resume continues on when cordis.yml
 * does not pin a complete override. The status line derives the resumed
 * session's route from this so the display follows the session, not the
 * startup resolution. A log without any header (a session that never started
 * a turn) records no route.
 * @param events - The session's durable event log.
 * @returns The last recorded route, or undefined when the log has none.
 */
export declare function recordedModelRoute(events: readonly {
    type: string;
    data?: unknown;
}[]): ModelRoute | undefined;
/**
 * Best-effort combination check (issue #67): when the llm runtime advertises
 * a non-empty catalog for the route's provider and the model is not in it,
 * reject the whole route in favor of `fallback` so a stale persisted choice
 * surfaces at startup instead of as a server-side model-name error. Any
 * uncertainty — no llm service, a failed or empty catalog — trusts the route.
 * @param llm - The llm runtime seam, when mounted.
 * @param route - The resolved route to check.
 * @param fallback - Route to adopt when the check rejects.
 * @returns The adopted route plus the rejected one (for a warning), if any.
 */
export declare function validateModelRoute(llm: {
    listModels(provider: string): Promise<readonly {
        id: string;
    }[]>;
} | undefined, route: ModelRoute, fallback?: ModelRoute): Promise<{
    route: ModelRoute;
    rejected?: ModelRoute;
}>;
//# sourceMappingURL=modelRoute.d.ts.map