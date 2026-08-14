/**
 * Agent-presets roster integration (issue #8): compose each session's
 * model-facing world (tools, prompt sections, projections) from one preset
 * directory instead of the host composition.
 *
 * Mirrors the official host's integration (dsh-host-apiproxy's
 * `composeAgent`): the preset id is resolved BEFORE create/resume because the
 * session boundary snapshots `meta` (the durable header's `agentPreset`)
 * before asynchronous setup begins; the mount itself runs inside the agent
 * factory's `setup(agentCtx)` hook, where a composition failure rolls the
 * whole creation back instead of publishing a half-configured agent.
 *
 * A deployment without the roster (bare `dsh --config cordis.yml` boots,
 * older CLI without the shipped preset root) composes nothing: callers get
 * no `setup` and every session shares the host composition — the behavior
 * before presets existed.
 */
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
/**
 * The mounted preset roster, or undefined when the composition has no
 * `agent-presets` row (bare boots) — optional-service access via `ctx.get`.
 */
export function rosterOf(ctx) {
    return ctx.get('agentPresets');
}
/**
 * Resolve the preset one new/resumed session will run under and the setup
 * that installs it. `requested` undefined adopts the roster default.
 *
 * Resolution failures (unknown/broken preset id, an empty roster that cannot
 * supply even the default) degrade to the rosterless composition with a loud
 * log line: a session that cannot start at all is worse than one running on
 * the host composition.
 *
 * @param ctx - The plugin context (roster lookup + logging).
 * @param requested - The preset id the caller wants, or undefined for the default.
 * @returns The header value + setup hook, or an empty composition.
 */
export async function composePreset(ctx, requested) {
    const presets = rosterOf(ctx);
    if (presets === undefined)
        return {};
    let resolvedId;
    try {
        resolvedId = (await presets.resolve(requested)).id;
    }
    catch (error) {
        ctx.logger.warn(`dsh-tui: agent preset ${requested === undefined ? '(default)' : `"${requested}"`} unavailable ` +
            `(${error instanceof Error ? error.message : String(error)}) — composing the session without a preset`);
        return {};
    }
    return {
        agentPreset: resolvedId,
        setup: async (agentCtx) => {
            await presets.mount(agentCtx, resolvedId);
        },
    };
}
/**
 * The preset a PERSISTED session actually runs, read from its log: the last
 * `agent-preset/selected` event wins over the creation header (a blank
 * session may have switched). undefined when the log records none (sessions
 * from before presets existed → the roster default applies at mount).
 *
 * @param ctx - The plugin context (persistence lookup).
 * @param sessionId - The persisted session to inspect.
 * @returns The running preset id, or undefined when unrecorded/unreadable.
 */
export async function resolvePersistedPreset(ctx, sessionId) {
    const persistence = ctx.get('sessionPersistence');
    if (persistence === undefined)
        return undefined;
    try {
        const { meta, events } = await persistence.load(sessionId);
        return resolveSessionPreset({
            header: meta,
            events,
        });
    }
    catch {
        // A missing/corrupt artifact leaves resume itself to report the failure;
        // the preset lookup must not mask it with a second, misleading error.
        return undefined;
    }
}
/**
 * The preset a LIVE session runs, resolved from its own log (last
 * `agent-preset/selected` wins over the header). Used for fork-style creates
 * (rewind/model switch) and for reading an already-live agent's composition.
 *
 * @param session - The live session (`header` + `events`).
 * @returns The running preset id, or undefined when the log records none.
 */
export function runningPresetOf(session) {
    return resolveSessionPreset(session);
}
/**
 * Read a service the way a joined agent sees it: through the preset scope
 * chain when a roster is mounted (preset realms hide e.g. `compaction` from
 * the root context), falling back to the host context otherwise. Mirrors the
 * official host's `agentPresets.serviceFor(agent, key) ?? ctx.get(key)`.
 *
 * @param ctx - The plugin context (roster + host fallback).
 * @param agent - The live agent whose scope chain resolves first.
 * @param key - The cordis service key.
 * @returns The service instance, or undefined when neither layer provides it.
 */
export function serviceForAgent(ctx, agent, key) {
    const presets = rosterOf(ctx);
    const scoped = presets?.serviceFor?.(agent, key);
    if (scoped !== undefined)
        return scoped;
    return ctx.get(key);
}
