/**
 * UI-side agent-team helpers (design agent-team-full). The DOMAIN types
 * live in the channel port (`adapter/ports/channel-view.ts`, T-A's seam)
 * and are re-exported here so every UI import site names one source of
 * truth; this module keeps only what is genuinely scene-layer concerns:
 * the Agent View source stack and the compose-target resolution.
 */
import type { AgentIdentity } from '../../adapter/ports/channel-view.js'

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
