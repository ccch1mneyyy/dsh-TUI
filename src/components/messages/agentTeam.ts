/**
 * Neutral agent-team domain contract (design agent-team-full §3), UI side.
 *
 * The channel/backend side (T-A) implements the same shapes on
 * `subagentControl` / the channel port; until that integration lands, the
 * UI feature-detects those optional fields through `agentTeamCapabilities`
 * below and simply does not render the surfaces (capability absence is
 * absence — never an apology state, never a fabricated one). Fixtures drive
 * these types directly, so the UI contract is regression-locked ahead of
 * the channel seam.
 */

/** §3 AgentIdentity — one addressable agent in the team view. */
export interface AgentIdentity {
  readonly agentId: string
  readonly parentAgentId?: string | null
  readonly sessionId?: string
  /** Stable display name; absent when the backend reports none (Claude
   *  SubagentState has no stable Agent.name — addressing falls to ids). */
  readonly name?: string
  /** The roster's display label (e.g. the card description). */
  readonly label?: string
  readonly mode?: 'one-shot' | 'continuable' | 'unknown'
  readonly status?: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
}

/** §3 via — the observable transport of one agent message. */
export type AgentMessageVia =
  | 'claude-parent-mediated'
  | 'dsh-direct-continuable'
  | 'dsh-agent-relay'

/** §3 state — the unified delivery vocabulary. States only advance through
 *  what the channel actually reported; `unknown` is a legal terminal state. */
export type AgentMessageDeliveryState =
  | 'issued'
  | 'queued'
  | 'delivered'
  | 'held'
  | 'refused'
  | 'expired'
  | 'unknown'

/** §3 AgentMessageView — one agent↔agent (or user→agent) message fact.
 *
 * `messageId` is the durable inbox/session message id; `intentId` is the
 *  local submit id — never interchangeable. `sourceRef` points back at the
 *  parent tool card / child event / DSH prompt receipt. `from`/`to` are
 *  agent ids (`'user'` for the human origin); either may be absent — then
 *  the row renders the unknown-relation diagnostic WITHOUT an arrow. */
export interface AgentMessageView {
  readonly messageId: string
  readonly intentId?: string
  readonly from?: string
  readonly to?: string
  readonly via: AgentMessageVia
  readonly text: string
  readonly state: AgentMessageDeliveryState
  readonly sourceRef?: string
  readonly observedAt: number
  readonly parentSessionId?: string
}

/** §5.1 the composer's target face, resolved by the wiring from the
 *  channel's roster: a unique name addresses by name, duplicates address
 *  by stable id (disambiguated, still submittable), and no name at all has
 *  no submit affordance — only the notice. */
export interface AgentComposeTarget {
  readonly agentId: string
  /** Unique across the roster → address by name. */
  readonly name?: string
  /** The name is duplicated across agents → address by stable id. */
  readonly ambiguous?: true
}

/** §5.2/§5.3 dispatch input. `delivery` is 'queue' on Enter; 'steer' only
 *  on Ctrl+Enter AND only when the capability declares steer support. */
export interface AgentComposeDispatchInput {
  readonly intentId: string
  readonly targetAgentId: string
  readonly text: string
  readonly delivery: 'queue' | 'steer'
}

/** What a dispatch reported. `ok.state` is what the channel gave — the UI
 *  never upgrades it (a DSH receipt is `queued`, never "delivered/read"). */
export type AgentComposeDispatchOutcome =
  | { readonly ok: true; readonly state: AgentMessageDeliveryState; readonly messageId?: string }
  | {
      readonly ok: false
      readonly reason: 'unavailable' | 'target-ambiguous' | 'target-not-resumable' | 'parent-unavailable' | 'dispatch-failed' | 'cancelled'
      /** Stable, non-sensitive detail for the notice line (never a raw
       *  provider error, credential or prompt body). */
      readonly detail?: string
    }

/** §5.1 the composer capability the wiring passes in. Absent = this
 *  backend exposes no send path for the target → the composer is not
 *  rendered at all (no dead control). */
export interface AgentComposeCapability {
  readonly via: AgentMessageVia
  /** Ctrl+Enter = steer only under an explicit declaration (DSH direct);
   *  Claude mediation keeps Enter/Ctrl+Enter both followup. */
  readonly steer?: true
  dispatch(input: AgentComposeDispatchInput): Promise<AgentComposeDispatchOutcome>
}

/** §4.1 the Agent View source stack — where Esc returns to. The optional
 *  `panel` mark says the entry came from the side-panel agents surface, so
 *  the exit returns to the panel (route preserved) instead of the fullscreen
 *  form of the same screen. */
export type AgentViewSource =
  | { readonly kind: 'chat'; readonly returnFocus: 'prompt' | 'transcript' }
  | { readonly kind: 'agents-dashboard'; readonly panel?: true }
  | { readonly kind: 'agent-detail'; readonly agentId: string; readonly panel?: true }
  | { readonly kind: 'transcript-card'; readonly rowId: number }

/**
 * The optional channel faces this UI reads (T-A's seam, §4.3/§5.5).
 * Feature-detection stays permissive: unknown objects pass through when
 * the callable fields exist, so the integrated channel needs no UI change.
 */
export interface SubagentControlAgentTeamFace {
  /** The durable agent↔agent feed, newest last (may be empty). With an
   *  agentId: only the messages that child sent or received. */
  agentMessages?(agentId?: string): readonly AgentMessageView[]
  /** The compose path for one target (mediated or direct). */
  agentCompose?(target: { readonly agentId: string; readonly name?: string }): AgentComposeCapability | undefined
}

/** Read the optional agent-team faces off a channel control object without
 * importing channel types (fail-closed: missing/malformed → undefined). */
export function agentTeamCapabilities(control: unknown): SubagentControlAgentTeamFace | undefined {
  if (typeof control !== 'object' || control === null) return undefined
  const face = control as Partial<SubagentControlAgentTeamFace>
  if (typeof face.agentMessages !== 'function' && typeof face.agentCompose !== 'function') return undefined
  return face
}

/** Resolve the compose capability for one roster entry (fail-closed). */
export function agentComposeFor(
  face: SubagentControlAgentTeamFace | undefined,
  target: AgentComposeTarget,
): AgentComposeCapability | undefined {
  if (face === undefined || typeof face.agentCompose !== 'function') return undefined
  try {
    const capability = face.agentCompose({ agentId: target.agentId, ...(target.name === undefined ? {} : { name: target.name }) })
    return capability ?? undefined
  } catch {
    return undefined
  }
}

/** Resolve a compose target from the roster: unique label addresses by
 * name, duplicates carry `ambiguous` (the composer shows the stable id),
 * no label at all stays nameless. */
export function agentComposeTargetOf(agentId: string, labels: ReadonlyMap<string, string>): AgentComposeTarget {
  const name = labels.get(agentId)
  if (name === undefined || name === '') return { agentId }
  let duplicates = 0
  for (const other of labels.values()) if (other === name) duplicates += 1
  return duplicates > 1 ? { agentId, name, ambiguous: true } : { agentId, name }
}
