/**
 * What a channel composition needs from its host, without naming Cordis:
 * service lookups, a logger, the lifetime hook, the DecisionEvents dispatch
 * and gate, and the DSH-only `agent/pre-step` waterfall. Implemented by
 * `cordis-host.ts`. Lookups for services the host does not mount return
 * undefined, and every consumer degrades on that.
 */
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { AdapterRuntimeOptions } from '../../adapter/kernel/runtime.js'
import type { GrantStore } from '../../adapter/standard/grants.js'
import type { TuiSettingsSectionsHost } from '../settings-sections.js'

/** Named host service lookup (`fs`, `attachments`, `shell`, `settings`,
 *  `credentials`, `llm`, `dshAuth` and the `tui*` rows); a Cordis context
 *  satisfies it as is. */
export interface ServiceLookup {
  get(name: string): unknown
}

export interface ChannelHostLogger {
  warn(message: string, ...args: unknown[]): void
}

/** The `agent/pre-step` waterfall listener (DSH sessions only). */
export type AgentPreStepListener = (
  payload: unknown,
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>

export interface ChannelHost extends ServiceLookup {
  readonly logger: ChannelHostLogger
  /** The adapter-mode snapshot of this composition root. */
  readonly runtime: AdapterRuntimeOptions
  /** Tie a teardown to the host's lifetime; absent = the channel owner's
   *  release is the only teardown. */
  effect?(setup: () => () => void, label?: string): void
  /** Subscribe to the agent's pre-step waterfall; absent off DSH. */
  onAgentPreStep?(listener: AgentPreStepListener): () => void
  /** Run a `tui/*` decision event through its registered handlers. */
  dispatchDecision<T>(
    name: string,
    payload: Record<string, unknown>,
    normalize: (result: unknown, warn: (what: string) => void) => T | undefined,
  ): Promise<T | undefined>
  /** Fire a `tui/*` notification event (no result). */
  dispatchNotification(name: string, payload: Record<string, unknown>): Promise<void>
  /** Install the default-deny decision-subscription gate (idempotent per root). */
  installDecisionGuard(grants: GrantStore): void
  /** Record that this composition dispatches DecisionEvents; returns the undo. */
  markDecisionDispatchTopology(): () => void
  /** The in-package settings-sections host, used when no row provides one. */
  localSettingsSections(): TuiSettingsSectionsHost
  /** Hear about named services coming or going after construction; absent = never. */
  watchServices?(listener: (name: string) => void): () => void
}
