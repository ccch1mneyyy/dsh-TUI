/**
 * Per-agent tool visibility.
 *
 * Upstream 0.2.2 moved tool declarations out of the prompt assembly
 * (`PromptPresentation` carries sections/contexts/variables only) and keeps
 * `tools.restrict()` as the scoped seam: a restriction lives on the agent's
 * own context, intersects down the scope chain, and rejects unknown names.
 * The preset and team carve-outs that used to filter the assembled tool list
 * are applied here instead. Older hosts have no `restrict` (probed by shape),
 * so there the registry keeps its own visibility rules and only the section
 * half of the carve-out survives.
 */
import type { Context } from '@deepseek-ai/cordis'
import { presetToolDeny, runningPresetOf } from './presets.js'
import { teamReplacedToolDeny } from './team-mode.js'

/** One registered tool definition, as much as the restriction needs. */
interface ToolDefinitionLike {
  readonly name: string
}

/** The registry surface `tools.restrict()` exposes on an agent scope. */
interface ToolsServiceLike {
  restrict?(filter: { readonly deny?: readonly string[] }): () => void
  definitions?(scope?: unknown): readonly ToolDefinitionLike[]
}

/** The agent shape the scope needs: its scoped context and session. */
export interface ScopedAgentLike {
  readonly ctx: Context
  readonly session: unknown
}

export interface ToolScope {
  /** (Re)apply the preset/team restriction for one agent. */
  apply(agent: ScopedAgentLike): void
}

/**
 * Track the restriction installed per agent and refresh it when the preset,
 * the team bundle, or the registry changes.
 *
 * @param ctx - The composition context; used for the warning path only.
 * @param own - Registration funnel so the caller's lifetime owns the listeners.
 * @returns The scope; callers apply it on bind and after a preset switch.
 */
export function createToolScope(
  ctx: Context,
  own: (dispose: () => void) => void,
  currentAgent: () => ScopedAgentLike | undefined,
): ToolScope {
  const applied = new WeakMap<object, { readonly signature: string; readonly dispose: () => void }>()

  const apply = (agent: ScopedAgentLike): void => {
    // Fake agents in focused regressions carry no cordis context; a host
    // without `tools` (or without the restricted seam) is a no-op.
    const scoped = agent.ctx as unknown as { get?(key: string): ToolsServiceLike | undefined }
    if (typeof scoped.get !== 'function') return
    const service = scoped.get('tools')
    if (service?.restrict === undefined) return
    // A restriction may only name tools the registry knows; a bundle enabled
    // later shows up through `tools/change`, which refreshes this.
    const known = new Set((service.definitions?.() ?? []).map(definition => definition.name))
    const deny = [...new Set([
      ...presetToolDeny(runningPresetOf(agent.session)),
      ...teamReplacedToolDeny(known),
    ])].filter(name => known.has(name))
    const signature = deny.join('\n')
    if (applied.get(agent)?.signature === signature) return
    applied.get(agent)?.dispose()
    applied.delete(agent)
    // `restrict({})` is rejected upstream; an empty carve-out means "no opinion".
    if (deny.length === 0) return
    try {
      applied.set(agent, { signature, dispose: service.restrict({ deny }) })
    } catch (error) {
      // Failing agent creation over a tool name the registry has not seen yet
      // would be worse than the leak; `tools/change` retries with a fresh view.
      ctx.logger?.warn?.('dsh-tui: could not restrict tools for the agent', error)
    }
  }

  // Registration changes (a bundle toggled at run time) can add or drop the
  // names a carve-out targets; intersect again instead of keeping a stale set.
  // Only the agent the channel currently shows is refreshed: a parked session
  // keeps the restriction installed on its own scope, and a child inherits its
  // parent's restriction through the scope chain.
  own(ctx.on('tools/change' as never, (() => {
    const agent = currentAgent()
    if (agent !== undefined) apply(agent)
  }) as never))

  return { apply }
}
