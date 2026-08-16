/** Runtime inheritance for enhancement overlays mounted outside the preset roster. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

export type EnhancementKind = 'smart'

interface MountedEnhancement {
  readonly kind: EnhancementKind
  readonly installChild: (childCtx: Context) => void
}

interface RootState {
  readonly mounted: WeakMap<Agent, MountedEnhancement>
}

const roots = new WeakMap<object, RootState>()

function stateFor(hostCtx: Context): RootState {
  const root = hostCtx.root
  const existing = roots.get(root)
  if (existing !== undefined) return existing

  const state: RootState = { mounted: new WeakMap() }
  roots.set(root, state)
  const dispose = root.on('agent/created', ({ agent }) => {
    const header = agent.session.header
    // Replacement sessions also carry parentSession. Only DSH-created
    // subagents carry origin=subagent and inherit their live parent's overlay.
    if (header.origin !== 'subagent' || header.parentSession === undefined) return
    const parent = root.agents.get(header.parentSession)
    if (parent === undefined) return
    const inherited = state.mounted.get(parent)
    if (inherited === undefined) return
    inherited.installChild(agent.ctx)
    state.mounted.set(agent, inherited)
  })
  hostCtx.effect(() => () => {
    dispose()
    if (roots.get(root) === state) roots.delete(root)
  }, 'dsh-tui: enhancement child inheritance')
  return state
}

/** Record a mounted parent so spawn, fork, and continuable children inherit it. */
export function registerEnhancementAgent(
  hostCtx: Context,
  agent: Agent,
  kind: EnhancementKind,
  installChild: (childCtx: Context) => void,
): void {
  stateFor(hostCtx).mounted.set(agent, { kind, installChild })
}

/** Runtime truth before a child's first request/header or sidecar state is durable. */
export function enhancementOf(hostCtx: Context, agent: Agent): EnhancementKind | undefined {
  return stateFor(hostCtx).mounted.get(agent)?.kind
}
