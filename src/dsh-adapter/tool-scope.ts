/** Per-agent preset/team tool visibility on the 0.2.2 registry seam.
 * Older hosts retain the final assembly filters in plugin.ts instead.
 */
import type { Context } from '@deepseek-ai/cordis'
import * as scope from '@deepseek-ai/dsh-scope'
import { presetToolDeny, runningPresetOf } from './presets.js'
import { teamReplacedToolDeny } from './team-mode.js'

interface ToolDefinitionLike {
  readonly name: string
}

interface ToolsServiceLike {
  restrict?(filter: { readonly deny?: readonly string[] }): () => void
  definitions?(scope?: object): readonly ToolDefinitionLike[]
}

/** The agent shape the restriction needs; no driver implementation is owned here. */
export interface ScopedAgentLike {
  readonly ctx: Context
  readonly session: unknown
}

export interface ToolScope {
  /** Track an existing agent and refresh the composition's live scopes. */
  apply(agent: ScopedAgentLike): void
}

// Scope ancestry and definitions arrived after the oldest supported hosts.
// Probe the public export by shape; the legacy assembly path needs neither.
const scopeParentOf = (scope as { readonly scopeParentOf?: (key: object) => object | undefined }).scopeParentOf

/**
 * Keep one exact restriction per live agent, including background/child agents
 * that never bind to the screen. Agent publication awaits agent/created, so its
 * restriction is installed before the factory releases any queued work.
 *
 * @param ctx - Composition context supplying the registry and lifecycle events.
 * @param own - Channel lifetime funnel; releases listeners and every owned mask.
 * @param currentAgent - Initial/borrowed foreground not necessarily in the registry.
 */
export function createToolScope(
  ctx: Context,
  own: (dispose: () => void) => void,
  currentAgent: () => ScopedAgentLike | undefined,
): ToolScope {
  const tools = (ctx as unknown as { get?(key: string): ToolsServiceLike | undefined }).get?.('tools')
  // No registry-side work is needed on legacy hosts (or a rosterless fixture).
  // Their assembly filter is still authoritative, with its original lifecycle.
  if (typeof tools?.restrict !== 'function' || typeof tools.definitions !== 'function' || scopeParentOf === undefined) return { apply: () => undefined }
  const tracked = new Set<ScopedAgentLike>()
  const retired = new WeakSet<object>()
  const applied = new Map<ScopedAgentLike, { readonly signature: string; readonly dispose: () => void }>()
  const listeners: Array<() => void> = []
  let closed = false
  let refreshing = false
  let refreshQueued = false

  const release = (agent: ScopedAgentLike): void => {
    const previous = applied.get(agent)
    applied.delete(agent)
    previous?.dispose()
  }
  own(() => {
    closed = true
    const failures: unknown[] = []
    for (const dispose of [...listeners.splice(0), ...[...applied.values()].map(entry => entry.dispose)]) {
      try { dispose() } catch (error) { failures.push(error) }
    }
    applied.clear()
    tracked.clear()
    if (failures.length > 0) throw new AggregateError(failures, 'dsh-tui: tool scope cleanup failed')
  })

  const applyOne = (agent: ScopedAgentLike): void => {
    const scoped = agent.ctx as unknown as { get?(key: string): ToolsServiceLike | undefined } | undefined
    const service = scoped?.get?.('tools')
    if (typeof service?.restrict !== 'function' || typeof service.definitions !== 'function' || scopeParentOf === undefined) return
    try {
      // The parent view contains inherited/restrictable names before OUR mask.
      // The exact-agent view also contains own-scope Team tools. Using the
      // latter alone would forget already-hidden spawners on the next refresh;
      // using the global view would never see preset or Team registrations.
      const inherited = new Set(service.definitions(scopeParentOf(agent)).map(tool => tool.name))
      const visible = new Set(service.definitions(agent).map(tool => tool.name))
      const deny = [...new Set([
        ...presetToolDeny(runningPresetOf(agent.session)),
        ...teamReplacedToolDeny(new Set([...inherited, ...visible])),
      ])].filter(name => inherited.has(name)).sort()
      const signature = deny.join('\n')
      if (applied.get(agent)?.signature === signature) return
      release(agent)
      // Empty filters are rejected upstream and carry no opinion here.
      if (deny.length > 0) applied.set(agent, { signature, dispose: service.restrict({ deny }) })
    } catch (error) {
      ctx.logger?.warn?.('dsh-tui: could not restrict tools for the agent', error)
    }
  }
  const refresh = (): void => {
    if (closed) return
    // Both install AND disposal synchronously emit tools/change. Finish the
    // atomic refresh first, then coalesce those events into one stable pass.
    refreshQueued = true
    if (refreshing) return
    refreshing = true
    try {
      do {
        refreshQueued = false
        const registry = (ctx as unknown as { get?(key: string): { list?(): readonly ScopedAgentLike[] } | undefined }).get?.('agents')
        const foreground = currentAgent()
        for (const agent of registry?.list?.() ?? []) if (!retired.has(agent)) tracked.add(agent)
        if (foreground !== undefined && !retired.has(foreground)) tracked.add(foreground)
        for (const agent of tracked) applyOne(agent)
      } while (refreshQueued && !closed)
    } finally {
      refreshing = false
    }
  }
  const apply = (agent: ScopedAgentLike): void => {
    if (closed || retired.has(agent)) return
    tracked.add(agent)
    refresh()
  }
  listeners.push(ctx.on('tools/change' as never, refresh as never))
  listeners.push(ctx.on('agent/created', ({ agent }) => {
    apply(agent)
    return undefined
  }))
  listeners.push(ctx.on('agent/disposed', ({ agent }) => {
    retired.add(agent)
    tracked.delete(agent)
    release(agent)
  }))
  listeners.push(ctx.on('session/event', (_session, event) => {
    if ((event as { type: string }).type === 'agent-preset/selected') refresh()
  }))
  refresh()
  return { apply }
}
