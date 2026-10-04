/**
 * UI-side agent-team helpers (design agent-team-full). The DOMAIN types
 * live in the channel port (`adapter/ports/channel-view.ts`, T-A's seam)
 * and are re-exported here so every UI import site names one source of
 * truth; this module keeps only what is genuinely scene-layer concerns:
 * the Agent View source stack and the compose-target resolution.
 */
import type { AgentIdentity } from '../../adapter/ports/channel-view.js'
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

/** §4.1 the Agent View source stack — where Esc returns to. The optional
 *  `panel` mark says the entry came from the side-panel agents surface, so
 *  the exit returns to the panel (route preserved) instead of the fullscreen
 *  form of the same screen. */
export type AgentViewSource =
  | { readonly kind: 'chat'; readonly returnFocus: 'prompt' | 'transcript' }
  | { readonly kind: 'agents-dashboard'; readonly panel?: true }
  | { readonly kind: 'agent-detail'; readonly agentId: string; readonly panel?: true }
  | { readonly kind: 'transcript-card'; readonly rowId: number }

/** §5.1 the composer's target face, resolved by the wiring from the roster
 *  (or the control's `listTargets`): a unique name addresses by name,
 *  duplicates address by stable id (disambiguated, still submittable), and
 *  no name at all has no submit affordance — only the notice. */
export interface AgentComposeTarget {
  readonly agentId: string
  /** Unique across the roster → address by name. */
  readonly name?: string
  /** The name is duplicated across agents → address by stable id. */
  readonly ambiguous?: true
}

/** Resolve a compose target from the roster's labels (the descriptions) or
 *  the control's own identity list: unique label addresses by name,
 *  duplicates carry `ambiguous` (the composer shows the stable id), no label
 *  at all stays nameless. */
export function agentComposeTargetOf(agentId: string, labels: ReadonlyMap<string, string>): AgentComposeTarget {
  const name = labels.get(agentId)
  if (name === undefined || name === '') return { agentId }
  let duplicates = 0
  for (const other of labels.values()) if (other === name) duplicates += 1
  return duplicates > 1 ? { agentId, name, ambiguous: true } : { agentId, name }
}

/** The same resolution over the control's addressable identities
 *  (`listTargets` roster): name wins when unique, label stands in when the
 *  backend reports no stable name. */
export function agentComposeTargetOfIdentity(agentId: string, targets: readonly AgentIdentity[]): AgentComposeTarget {
  const labels = new Map<string, string>()
  for (const target of targets) labels.set(target.agentId, target.name ?? target.label ?? '')
  return agentComposeTargetOf(agentId, labels)
}

// ── workbench parent/sibling math (design agent-team-panels §3 P3) ──────────

/** Who spawned an agent, as a PROVABLE fact. 'main' = the session's main
 *  loop — proven by depth 1 alone (the SDK's spawn-depth definition).
 *  'agent' = a named parent agent. 'unknown' = no fact: depth >= 2 without
 *  a parent id (old metadata) must NEVER collapse into 'main' or a
 *  depth-mate (agent-team §2: the tree only trusts parent facts, orphans
 *  are not drawn). */
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

/** The switchable neighbourhood of the viewed agent (design §3 P3
 *  workbench): its parent row and its siblings — roster agents PROVABLY
 *  spawned by the same parent. Depth-equality alone never makes siblings;
 *  an unknown parent yields no siblings (honest absence, not a guess). */
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
