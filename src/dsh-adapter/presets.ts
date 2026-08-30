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
import {
  resolveCompatiblePreset,
  resolveRecordedPreset,
  rosterOf,
} from './preset-resolution.js'

const ASK_USER_TOOL = 'ask_user_question'

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
  const persistence = ctx.get('sessionPersistence') as
    | {
        load(id: SessionId): Promise<{
          meta: { agentPreset?: string }
          events: readonly { type: string; data: unknown }[]
        }>
      }
    | undefined
  if (persistence === undefined) return undefined
  try {
    const { meta, events } = await persistence.load(sessionId)
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
 * @param session - The live session (`header` + `events`).
 * @returns The running preset id, or undefined when the log records none.
 */
export function runningPresetOf(session: {
  header: { agentPreset?: string }
  events: readonly { type: string; data: unknown }[]
}): string | undefined {
  return resolveRecordedPreset(session)
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
  const persistence = ctx.get('sessionPersistence') as
    | {
        load(id: SessionId): Promise<{
          meta: unknown
          events: readonly { type: string; data?: unknown }[]
        }>
      }
    | undefined
  if (persistence === undefined) return undefined
  try {
    const { events } = await persistence.load(sessionId)
    return recordedModelRoute(events)
  } catch {
    // A missing/corrupt artifact leaves resume itself to report the failure;
    // the route lookup must not mask it with a second, misleading error.
    return undefined
  }
}

/**
 * Keep the official Minimal preset's model-facing contract at exactly two
 * tools. The TUI mounts ask_user_question at the host layer so every other
 * preset (including user presets) can use its questionnaire UI; host-layer
 * tools otherwise merge into Minimal's scoped catalog as a third tool.
 *
 * This is a per-assembly filter rather than a startup-time decision because
 * one TUI process can resume, create, or recompose sessions under different
 * presets. The session log remains the source of truth for the active preset.
 *
 * @param assembly - Fully assembled prompt inputs for one model request.
 * @param presetId - Preset recorded for the requesting session.
 * @returns The original assembly, except ask_user_question is absent in Minimal.
 */
export function filterMinimalPresetTools(assembly: PromptAssembly, presetId: string | undefined): PromptAssembly {
  if (presetId !== 'minimal' || !assembly.tools.some(tool => tool.name === ASK_USER_TOOL)) return assembly
  return {
    ...assembly,
    tools: assembly.tools.filter(tool => tool.name !== ASK_USER_TOOL),
  }
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
