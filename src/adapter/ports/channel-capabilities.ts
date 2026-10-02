/** Host-owned in-process Channel contract. No runtime or upstream imports. */

/**
 * How one model-facing slash command is served for the CURRENT agent.
 *
 * - `local` — the TUI itself owns the implementation and it is mounted;
 * - `registry` — only a DSH `dsh-commands` registration can serve the line;
 * - `none` — neither path exists, so the entry must READ as unavailable
 *   instead of looking usable and failing on use.
 */
export type CommandRoute = 'local' | 'registry' | 'none'

/**
 * i18n keys naming WHY one capability is missing (`src/i18n.ts`). The union is
 * declared here so the reason is enforced by the type system at every route
 * site while the ports layer stays free of `src/` imports.
 */
export type CapabilityReasonKey =
  | 'capability-reason-no-compaction'
  | 'capability-reason-no-plan-command'

/** One command's route, with the reason to report when no route exists. */
export type CommandCapability =
  | { readonly route: 'local' }
  | { readonly route: 'registry' }
  | { readonly route: 'none'; readonly reasonKey: CapabilityReasonKey }

/**
 * What the current agent's composition can actually do, as FACTS resolved from
 * the live services its own scope chain exposes — never from a preset-id table.
 * A user preset that adds a service back therefore gains the full feature set
 * with no TUI change.
 *
 * Evidence per field lives in `dsh-adapter/channel/capabilities.ts`.
 */
export interface AgentCapabilities {
  /** Route `/compact` takes (the TUI's own transaction wins when mounted). */
  readonly compact: CommandCapability
  /** Route `/plan` takes (registry-only: the TUI implements no plan mode). */
  readonly plan: CommandCapability
  /** Automatic between-step compaction is mounted for this agent. */
  readonly compaction: boolean
  /** Tool-result pruning is mounted for this agent's sessions. */
  readonly pruner: boolean
  /** The agent can park on the questionnaire seam and ask the user. */
  readonly questionTool: boolean
  /** A skill registry serves this agent. */
  readonly skills: boolean
}
