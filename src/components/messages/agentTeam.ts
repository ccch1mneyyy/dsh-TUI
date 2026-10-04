/**
 * UI-side agent-team helpers. The message domain types live in the channel
 * port (`adapter/ports/channel-view.ts`) and are re-exported for the UI;
 * this module adds the Agent View source stack, compose-target resolution
 * and the parent/sibling math of the workbench.
 */
import type { SubagentState } from '../../dsh-adapter/subagents.js'

export type {
  AgentIdentity,
  AgentMessageControl,
  AgentMessageState,
  AgentMessageSubmitInput,
  AgentMessageSubmitResult,
  AgentMessageView,
  AgentMessageVia,
} from '../../adapter/ports/channel-view.js'

/** Where the Agent View was opened from, i.e. where Esc returns to. The optional
 *  `panel` mark says the entry came from the side-panel agents surface, so
 *  the exit returns to the panel (route preserved) instead of the fullscreen
 *  form of the same screen. */
export type AgentViewSource =
  | { readonly kind: 'chat'; readonly returnFocus: 'prompt' | 'transcript' }
  | { readonly kind: 'agents-dashboard'; readonly panel?: true }
  | { readonly kind: 'agent-detail'; readonly agentId: string; readonly panel?: true }
  | { readonly kind: 'transcript-card'; readonly rowId: number }

/** The composer's target, resolved from the roster: a unique name addresses
 *  by name, a duplicated one by stable id (still submittable), and no name
 *  at all has no submit, only the notice. */
export interface AgentComposeTarget {
  readonly agentId: string
  /** Unique across the roster → address by name. */
  readonly name?: string
  /** The name is duplicated across agents → address by stable id. */
  readonly ambiguous?: true
}

/** Resolve a compose target from the roster's labels (the descriptions):
 *  a unique label addresses by name, duplicates carry `ambiguous` (the
 *  composer shows the stable id), no label at all stays nameless. */
export function agentComposeTargetOf(agentId: string, labels: ReadonlyMap<string, string>): AgentComposeTarget {
  const name = labels.get(agentId)
  if (name === undefined || name === '') return { agentId }
  let duplicates = 0
  for (const other of labels.values()) if (other === name) duplicates += 1
  return duplicates > 1 ? { agentId, name, ambiguous: true } : { agentId, name }
}

// ── workbench parent/sibling math ───────────────────────────────────────────

/** Who spawned an agent, only as far as the data proves it. 'main' = the
 *  session's main loop (depth 1, the SDK's spawn-depth definition).
 *  'agent' = a named parent agent. 'unknown' = depth >= 2 without a parent
 *  id (old metadata): never folded into 'main' or into an agent at the
 *  same depth. */
export type AgentParentFact = { readonly kind: 'main' } | { readonly kind: 'agent'; readonly agentId: string } | { readonly kind: 'unknown' }

/** The parent fact of one roster row from the roster's own fields. */
export function agentParentFactOf(agent: Pick<SubagentState, 'parentAgentId' | 'depth'>): AgentParentFact {
  if (agent.parentAgentId !== undefined) return { kind: 'agent', agentId: agent.parentAgentId }
  if (agent.depth === 1) return { kind: 'main' }
  return { kind: 'unknown' }
}

/** The parent fact of the VIEWED agent, letting the loaded transcript's
 *  explicit parent override the roster's (the disk copy is the durable
 *  truth; a still-loading or absent transcript keeps the roster fact).
 *  transcriptParent follows SubagentTranscriptPage.parentAgentId: null =
 *  depth-1-or-old-format, so it only proves 'main' together with depth 1. */
export function viewedAgentParentFact(agent: SubagentState, transcriptParent: string | null | undefined): AgentParentFact {
  if (transcriptParent !== undefined && transcriptParent !== null) return { kind: 'agent', agentId: transcriptParent }
  if (transcriptParent === null && agent.depth === 1) return { kind: 'main' }
  return agentParentFactOf(agent)
}

/** The switchable neighbourhood of the viewed agent: its parent and its
 *  siblings, i.e. roster agents with the same known parent. The same depth
 *  alone never makes siblings; an unknown parent yields none. */
export function agentNeighbourhood(
  self: SubagentState,
  roster: readonly SubagentState[],
  transcriptParent: string | null | undefined,
): { readonly parent: AgentParentFact; readonly siblings: readonly SubagentState[] } {
  const parent = viewedAgentParentFact(self, transcriptParent)
  const parentOf = (other: SubagentState): AgentParentFact => agentParentFactOf(other)
  const sameParent = (other: SubagentState): boolean => {
    if (parent.kind === 'main') return parentOf(other).kind === 'main'
    if (parent.kind === 'agent') {
      const otherParent = parentOf(other)
      return otherParent.kind === 'agent' && otherParent.agentId === parent.agentId
    }
    return false
  }
  const siblings = parent.kind === 'unknown'
    ? []
    : roster.filter(other => other.agentId !== self.agentId && sameParent(other))
  return { parent, siblings }
}
