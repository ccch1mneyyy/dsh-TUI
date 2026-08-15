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
import type { Context } from '@deepseek-ai/cordis';
import type { AgentSetup } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
/** One roster entry, as returned by `agentPresets.list()`/`resolve()`. */
export interface AgentPresetInfo {
    readonly id: string;
    readonly trust: 'system' | 'user';
    readonly name?: string;
    readonly description?: string;
    /** Present when the preset cannot compose a session (human-readable). */
    readonly broken?: string;
}
/** The `ctx.agentPresets` service surface dsh-tui consumes. */
export interface AgentPresetsLike {
    readonly defaultId: string;
    list(): Promise<readonly AgentPresetInfo[]>;
    resolve(id?: string): Promise<AgentPresetInfo>;
    mount(agentCtx: Context, id?: string): Promise<AgentPresetInfo>;
    recompose(agentCtx: Context, id: string): Promise<AgentPresetInfo>;
    /** Read one service from the agent's own scope chain (preset realms). */
    serviceFor?(agent: {
        ctx: Context;
    }, key: string): unknown;
}
/**
 * The mounted preset roster, or undefined when the composition has no
 * `agent-presets` row (bare boots) — optional-service access via `ctx.get`.
 */
export declare function rosterOf(ctx: Context): AgentPresetsLike | undefined;
/** The composition inputs for `agents.create`/`agents.resume`. */
export interface PresetComposition {
    /** Value for the durable header's `meta.agentPreset`; absent without a roster. */
    readonly agentPreset?: string;
    /** Factory setup hook mounting the preset onto the unpublished agent. */
    readonly setup?: AgentSetup;
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
export declare function composePreset(ctx: Context, requested?: string): Promise<PresetComposition>;
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
export declare function resolvePersistedPreset(ctx: Context, sessionId: SessionId): Promise<string | undefined>;
/**
 * The preset a LIVE session runs, resolved from its own log (last
 * `agent-preset/selected` wins over the header). Used for fork-style creates
 * (rewind/model switch) and for reading an already-live agent's composition.
 *
 * @param session - The live session (`header` + `events`).
 * @returns The running preset id, or undefined when the log records none.
 */
export declare function runningPresetOf(session: {
    header: {
        agentPreset?: string;
    };
    events: readonly {
        type: string;
        data: unknown;
    }[];
}): string | undefined;
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
export declare function serviceForAgent<T>(ctx: Context, agent: {
    ctx: Context;
}, key: string): T | undefined;
//# sourceMappingURL=presets.d.ts.map