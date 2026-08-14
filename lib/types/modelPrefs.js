/**
 * Persisted model-route preference (`/model` picker choice), kept at
 * `~/.dsh-cc/model.json` (`provider` + `model` keys) so the choice survives
 * restarts — same pattern as agent-preset.json. The file is best-effort: a
 * missing/corrupt file or an incomplete route simply falls back to the
 * harness default. Explicit `provider`/`model` keys in cordis.yml win over
 * this preference (deployment choice over runtime preference, matching
 * activityFrames and agent-preset).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const PREFS_DIR = join(homedir(), '.dsh-cc');
/**
 * The harness default route: the adapter the bundled deployment ships with.
 * Lives in code, not in cordis.patch.yml — a config key expresses a
 * deployment DECISION, never a default, so the "default" branch of the
 * precedence below stays reachable in shipped compositions (issue #67).
 */
export const DEFAULT_MODEL_ROUTE = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
};
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
export function resolveModelRoute(configured, pref, fallback = DEFAULT_MODEL_ROUTE) {
    if (configured.provider !== undefined && configured.model !== undefined) {
        return {
            route: { provider: configured.provider, model: configured.model },
            source: 'config',
        };
    }
    if (pref !== undefined) {
        return { route: { provider: pref.provider, model: pref.model }, source: 'pref' };
    }
    return {
        route: {
            provider: configured.provider ?? fallback.provider,
            model: configured.model ?? fallback.model,
        },
        source: 'default',
    };
}
/**
 * Parse a persisted `{ provider, model }` value; anything else yields
 * undefined.
 * @param text - Raw file contents.
 * @returns The route when both halves are non-empty strings, else undefined.
 */
export function parseModelPref(text) {
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const { provider, model } = parsed;
        if (typeof provider !== 'string' || provider === '')
            return undefined;
        if (typeof model !== 'string' || model === '')
            return undefined;
        return { provider, model };
    }
    catch {
        return undefined;
    }
}
/**
 * The persisted model route, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted route, if any.
 */
export function readModelPref(dir = PREFS_DIR) {
    try {
        return parseModelPref(readFileSync(join(dir, 'model.json'), 'utf8'));
    }
    catch {
        return undefined;
    }
}
/**
 * Persist the chosen model route (best effort).
 * @param provider - Provider route to persist.
 * @param model - Provider-owned model id to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeModelPref(provider, model, dir = PREFS_DIR) {
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'model.json'), JSON.stringify({ provider, model }, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
