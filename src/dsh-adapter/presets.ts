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

import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { recordedModelRoute, type ModelRoute } from '../modelRoute.js'
import { snapshotLiveSessionEvents } from './compat/liveSession.js'
import { readPersistedSession, type SessionReader } from './compat/persistence.js'
import {
  resolveCompatiblePreset,
  resolveRecordedPreset,
  rosterOf,
} from './preset-resolution.js'
import { WORKTREE_TOOL } from './worktree-tool.js'

const ASK_USER_TOOL = 'ask_user_question'

/**
 * The prompt section `@deepseek-ai/dsh-experimental-session-search` contributes
 * to the host layer once that bundle is enabled (`order: TOOL_SESSION_QUERY`).
 * It is a section, not a tool: dropping only the five tools below would leave
 * Minimal's model reading guidance for tools it cannot call.
 */
const SESSION_SEARCH_SECTION = 'tool:session-query'

/**
 * The five read-only tools the same bundle registers on the host tool layer
 * (`@deepseek-ai/dsh-tool-session-query@0.2.1-rc.2`). The assembly carries no
 * per-tool provenance, so these names are the only way to recognise them —
 * same approach as `team-mode.ts`'s replaced-tool list. Renames upstream turn
 * this carve-out into a silent no-op; `verify:minimal-preset-tools` pins them.
 */
const SESSION_SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
])

/**
 * Whether a preset's model-facing catalog is fixed by its own composition and
 * must therefore be shielded from HOST-layer contributors the person switched
 * on elsewhere. Only the official Minimal preset qualifies.
 */
function isMinimalPreset(presetId: string | undefined): boolean {
  return presetId === 'minimal'
}

/**
 * Presets whose `bash` is the official persistent shell, which starts in the
 * directory of its first call and never follows a later move: Minimal, and
 * the bundled liangshen preset (the same shell on POSIX; its Windows
 * `custom-bash` does follow, but one rule for both platforms keeps this a
 * preset decision). After a worktree switch that shell would keep editing the
 * source checkout, so these presets are not offered `create_worktree` until the
 * shell follows the session directory (#1738).
 */
const PERSISTENT_SHELL_PRESETS: ReadonlySet<string> = new Set(['minimal', 'liangshen'])

/** The composition inputs for `agents.create`/`agents.resume`. */
export interface PresetComposition {
  /** Value for the durable header's `meta.agentPreset`; absent without a roster. */
  readonly agentPreset?: string
  /** Factory setup hook mounting the preset onto the unpublished agent. */
  readonly setup?: AgentSetup
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
export async function composePreset(ctx: Context, requested?: string): Promise<PresetComposition> {
  const presets = rosterOf(ctx)
  if (presets === undefined) return {}
  let resolvedId: string
  try {
    resolvedId = (await resolveCompatiblePreset(presets, requested)).id
  } catch (error) {
    ctx.logger.warn(
      `dsh-tui: agent preset ${requested === undefined ? '(default)' : `"${requested}"`} unavailable ` +
        `(${error instanceof Error ? error.message : String(error)}) — composing the session without a preset`,
    )
    return {}
  }
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx: Context) => {
      await presets.mount(agentCtx, resolvedId)
    },
  }
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
export async function resolvePersistedPreset(ctx: Context, sessionId: SessionId): Promise<string | undefined> {
  const persistence = ctx.get('sessionPersistence') as SessionReader | undefined
  if (persistence === undefined) return undefined
  try {
    const { meta, events } = await readPersistedSession(persistence, sessionId)
    return resolveRecordedPreset({ header: meta, events })
  } catch {
    // A missing/corrupt artifact leaves resume itself to report the failure;
    // the preset lookup must not mask it with a second, misleading error.
    return undefined
  }
}

/**
 * The preset a LIVE session runs, resolved from its own log (last
 * `agent-preset/selected` wins over the header). Used for fork-style creates
 * (rewind/model switch) and for reading an already-live agent's composition.
 *
 * @param session - The live session.
 * @returns The running preset id, or undefined when the log records none.
 */
export function runningPresetOf(session: unknown): string | undefined {
  const header = (session as { header?: { agentPreset?: string } }).header ?? {}
  return resolveRecordedPreset({ header, events: snapshotLiveSessionEvents(session) })
}

/**
 * The route a PERSISTED session actually ran, read from its log: the last
 * `request/header` snapshot. undefined when the log records none (a session
 * that never started a turn) or the artifact is unreadable.
 *
 * Resume feeds this back into `agents.resume({ agentOptions })` so the
 * resumed agent's `options.model` is populated again — a cordis.yml that
 * pins only `provider` (issue #67: a half-pin never merges) leaves
 * agentOptions.model undefined, which breaks the `{{model}}` persona variable
 * for the resumed agent's own assembly AND for every subagent it spawns
 * (dsh-subagent's `resolveChildAgentOptions` inherits `parent.options.model`).
 *
 * @param ctx - The plugin context (persistence lookup).
 * @param sessionId - The persisted session to inspect.
 * @returns The recorded model route, or undefined when unrecorded/unreadable.
 */
export async function resolvePersistedRoute(ctx: Context, sessionId: SessionId): Promise<ModelRoute | undefined> {
  const persistence = ctx.get('sessionPersistence') as SessionReader | undefined
  if (persistence === undefined) return undefined
  try {
    const { events } = await readPersistedSession(persistence, sessionId)
    return recordedModelRoute(events)
  } catch {
    // A missing/corrupt artifact leaves resume itself to report the failure;
    // the route lookup must not mask it with a second, misleading error.
    return undefined
  }
}

/**
 * Whether the host-layer `ask_user_question` tool must stay invisible to one
 * preset's model-facing catalog.
 *
 * The official Minimal preset is a single-persistent-shell trajectory
 * (`@deepseek-ai/dsh-web-app/presets/minimal.patch.yml`: `persona` +
 * `persistent-shell`, i.e. bash on POSIX / pwsh on Windows — `str_replace_editor`
 * has been opt-in since 0.1.3-alpha.2), while the TUI mounts
 * ask_user_question at the HOST layer so every other preset (including user
 * presets) can use its questionnaire UI; that host-layer tool otherwise merges
 * into Minimal's scoped catalog as an extra tool.
 *
 * The recorded preset id is the only signal available at the assembly
 * boundary: the composition exposes no per-tool manifest, and a host tool's
 * presence in the tool registry cannot tell whether a preset declared it. This
 * is therefore the ONE preset-id read in the capability path, shared with
 * `resolveAgentCapabilities` so advertisement and assembly agree, and pinned
 * by `verify:minimal-preset-tools`.
 *
 * @param presetId - Preset recorded for the requesting session.
 * @returns True when the host-layer tool must be filtered out of the assembly.
 */
export function presetHidesHostAskTool(presetId: string | undefined): boolean {
  return isMinimalPreset(presetId)
}

/**
 * Keep the official Minimal preset's model-facing catalog minimal: it declares
 * exactly one persistent shell tool, and host-layer contributors the person
 * switched on elsewhere must not become extra ones.
 *
 * Three such contributors are carved out here (the last one for liangshen
 * too, see `PERSISTENT_SHELL_PRESETS`):
 * - the host-mounted `ask_user_question` (see `presetHidesHostAskTool`);
 * - `@deepseek-ai/dsh-experimental-session-search`, which registers five
 *   read-only tools AND a usage-guidance section. The upstream bundle promises
 *   "every preset including minimal"; this app intentionally deviates, because
 *   Minimal's published promise is one persistent shell and a TUI process runs
 *   sessions under several presets at once — hence an assembly-boundary filter
 *   rather than a registry (or shell-whitelist) decision that would leak;
 * - `@deepseek-ai/dsh-experimental-tool-worktree`'s `create_worktree` (one
 *   host-layer tool, no section), which would move the session away from the
 *   persistent shell.
 *
 * This is per-assembly because one TUI process can resume, create, or
 * recompose sessions under different presets. The session log remains the
 * source of truth for the active preset.
 *
 * @param assembly - Fully assembled prompt inputs for one model request.
 * @param presetId - Preset recorded for the requesting session.
 * @returns The original assembly when nothing is carved out, else the filtered copy.
 */
export function filterMinimalPresetTools(assembly: PromptAssembly, presetId: string | undefined): PromptAssembly {
  const minimal = isMinimalPreset(presetId)
  const persistentShell = presetId !== undefined && PERSISTENT_SHELL_PRESETS.has(presetId)
  if (!minimal && !persistentShell) return assembly
  const tools = assembly.tools.filter(tool =>
    !(persistentShell && tool.name === WORKTREE_TOOL) &&
    !(minimal && (tool.name === ASK_USER_TOOL || SESSION_SEARCH_TOOLS.has(tool.name))))
  const sections = minimal ? assembly.sections.filter(section => section.name !== SESSION_SEARCH_SECTION) : assembly.sections
  if (tools.length === assembly.tools.length && sections.length === assembly.sections.length) return assembly
  return { ...assembly, tools, sections }
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
export function serviceForAgent<T>(ctx: Context, agent: { ctx: Context }, key: string): T | undefined {
  const presets = rosterOf(ctx)
  const scoped = presets?.serviceFor?.(agent, key)
  if (scoped !== undefined) return scoped as T
  return ctx.get(key) as T | undefined
}
