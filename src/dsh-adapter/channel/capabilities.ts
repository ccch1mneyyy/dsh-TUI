/**
 * One place that answers "can this agent actually do X?", with the evidence
 * for every answer.
 *
 * The TUI used to answer that question three different ways: `/permission`
 * read the merged command list or the permission-presets snapshot, `/plan`
 * read the command list only, and `/compact` asked nothing at all — so a
 * command could look available (Help, `/` completion) and then fail on use.
 * Every consumer now reads these facts: Chat's command switch, the
 * session-mode actions, and the Help/completion annotation applied where the
 * command list is built (`annotateCommandCapabilities`).
 *
 * Resolution is FACT-based on purpose. Each fact is read from the live service
 * the agent's own scope chain resolves (`presets.serviceForAgent`, which
 * mirrors the official host's `agentPresets.serviceFor(agent, key) ??
 * ctx.get(key)`), never from a preset-id table — a user preset that adds
 * compaction/pruning back gets the full feature set with no TUI change. The
 * single preset-id read left is the official Minimal `ask_user_question`
 * carve-out, and it lives in `presets.ts` (one source, pinned by
 * `verify:minimal-preset-tools`).
 *
 * Evidence per fact:
 *   compaction     `serviceForAgent(ctx, agent, 'compaction')` exposing
 *                  `compactNow` — the same seam the TUI transaction and the
 *                  official `/compact` command both call;
 *   pruner         `serviceForAgent(ctx, agent, 'toolResultPruner')`;
 *   skills         `serviceForAgent(ctx, agent, 'skills')`;
 *   compact/plan   the DSH command registry (`commands.find(agent, name)`,
 *                  scope-correct: same name in another scope is not this
 *                  agent's command). `/compact` prefers the TUI's own
 *                  transaction whenever the compaction service exists, because
 *                  that path owns the `tui/compact` decision event, the
 *                  progress row, Esc cancellation and the session-switch
 *                  settle; it falls back to the registry command only when the
 *                  local path cannot run.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { AgentCapabilities, CommandCapability } from '../../adapter/ports/channel-capabilities.js'
import type { LocalCommand } from '../../commands.js'
import { presetHidesHostAskTool, runningPresetOf, serviceForAgent } from '../presets.js'

/** The exact service surface `compaction` evidence requires. */
type CompactionSeam = { compactNow?: unknown }

/** Whether `/compact` can run through the TUI's own transaction. */
function hasCompactNow(service: unknown): boolean {
  return typeof (service as CompactionSeam | undefined)?.compactNow === 'function'
}

/**
 * Everything the resolver reads, passed in explicitly so the decision can be
 * driven from fixtures (the focused regression) instead of a live composition.
 */
export interface CapabilityEvidence {
  /** The live agent whose composition is described; undefined before a bind. */
  readonly agent: Agent | undefined
  /** `ctx.commands` (the DSH command registry), undefined without the row. */
  readonly commandService: CommandRuntime | undefined
  /** Read one service the way the agent sees it (preset scope chain first). */
  readonly service: (key: string) => unknown
  /** Whether the agent's scoped tool catalog carries one model-facing tool. */
  readonly toolPresent: (name: string) => boolean
  /** The preset recorded for the agent (only the Minimal carve-out reads it). */
  readonly presetId: string | undefined
}

/** Command name → the capability that gates its advertisement. */
const COMMAND_CAPABILITIES = new Map<string, (capabilities: AgentCapabilities) => CommandCapability>([
  ['compact', capabilities => capabilities.compact],
  ['plan', capabilities => capabilities.plan],
])

/**
 * Resolve the facts for one agent.
 *
 * @param evidence - The live reads described on {@link CapabilityEvidence}.
 * @returns Facts plus, for a missing route, the i18n key naming the reason.
 */
export function resolveAgentCapabilities(evidence: CapabilityEvidence): AgentCapabilities {
  const { agent, commandService, presetId } = evidence
  // The command service can be a partial shape (script fixtures, hosts whose row
  // does not expose the whole surface), so read `find` structurally and call it
  // as a method: a detached registry method loses `this` (see #864). A missing
  // member and a throwing one both mean "no registry route", never a throw out
  // of the capability read — this runs on the render path and inside bind()'s
  // gap notice, where an exception disposes the whole channel.
  const registered = (name: string): boolean => {
    // The unbound read is deliberate: the merged command list is built with the
    // same scope (`skill-catalog` calls `commandService.list(agent)` before the
    // first bind, which resolves the global-only view), so a registry command
    // the user can already see in Help must not read as unavailable merely
    // because no agent is bound yet — that is exactly the launchpad screen.
    if (commandService === undefined) return false
    const { find } = commandService
    if (typeof find !== 'function') return false
    try {
      return find.call(commandService, agent as Agent, name) !== undefined
    } catch {
      return false
    }
  }
  const compaction = hasCompactNow(evidence.service('compaction'))
  return {
    compact: compaction
      ? { route: 'local' }
      : registered('compact')
        ? { route: 'registry' }
        : { route: 'none', reasonKey: 'capability-reason-no-compaction' },
    plan: registered('plan')
      ? { route: 'registry' }
      : { route: 'none', reasonKey: 'capability-reason-no-plan-command' },
    compaction,
    pruner: evidence.service('toolResultPruner') !== undefined,
    // The TUI mounts ask_user_question at the HOST layer, so the tool catalog
    // alone is not evidence: the official Minimal preset's assembly filter
    // strips it again (see `presets.presetHidesHostAskTool`).
    questionTool: evidence.toolPresent('ask_user_question') && !presetHidesHostAskTool(presetId),
    skills: evidence.service('skills') !== undefined,
  }
}

/** The live evidence bag for one agent, read through its preset scope chain. */
export function agentCapabilityEvidence(ctx: Context, agent: Agent | undefined): CapabilityEvidence {
  const read = (key: string): unknown => {
    try {
      return agent === undefined ? ctx.get(key) : serviceForAgent<unknown>(ctx, agent, key)
    } catch {
      // A failing scope read must degrade to "not mounted", never break the
      // caller that is only describing what exists.
      return undefined
    }
  }
  return {
    agent,
    commandService: ctx.get('commands') as CommandRuntime | undefined,
    service: read,
    toolPresent: name => {
      try {
        const tools = ctx.get('tools') as { get(name: string, scope?: unknown): unknown } | undefined
        return tools?.get(name, agent) !== undefined
      } catch {
        return false
      }
    },
    presetId: agent === undefined ? undefined : recordedPresetId(agent),
  }
}

/**
 * The preset recorded for the agent, or undefined when the session cannot be
 * read. `runningPresetOf` walks the live session contract and throws on a
 * session that violates it; this bag must stay descriptive, so a bad read
 * degrades to "no preset recorded" rather than escaping into the caller (where
 * it would dispose the channel through bind()'s catch).
 */
function recordedPresetId(agent: Agent): string | undefined {
  try {
    return runningPresetOf(agent.session)
  } catch {
    return undefined
  }
}

/**
 * Mark the commands whose capability route is `none` so Help and `/`
 * completion state that instead of advertising a command that can only fail.
 *
 * The marker is a `descriptionKey` override, so `localizedDescription`
 * resolves it at render time (`/lang` applies immediately) and every list
 * consumer — Help menu, suggestion overlay, i18n verifier — picks it up with
 * no new UI mode. The command stays dispatchable: removing it from the list
 * would silently forward `/compact` to the model as a plain message.
 *
 * @param commands - The merged command list (locals + registry).
 * @param capabilities - Facts for the agent the list is built for.
 * @returns The same list, with `none`-route entries re-described.
 */
export function annotateCommandCapabilities(
  commands: readonly LocalCommand[],
  capabilities: AgentCapabilities,
): LocalCommand[] {
  let annotated: LocalCommand[] | undefined
  commands.forEach((command, index) => {
    const gate = COMMAND_CAPABILITIES.get(command.name)
    if (gate === undefined || gate(capabilities).route !== 'none') return
    annotated ??= [...commands]
    annotated[index] = { ...command, descriptionKey: `cmd-desc-${command.name}-unavailable` }
  })
  return annotated ?? (commands as LocalCommand[])
}
