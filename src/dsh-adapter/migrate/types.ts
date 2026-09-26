/**
 * Cross-agent conversation migration: shared types.
 *
 * An adapter turns one foreign agent's stored conversation into the neutral
 * {@link MigrationSession} shape; the sessionizer (see sessionize.ts) then
 * emits DSH session events. Adapters are read-only against their source and
 * defensive by default: a malformed line costs that line, never the scan.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/types
 */

/** One conversational turn in a foreign conversation, normalized. */
export interface MigrationTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
  /** Assistant reasoning trace, when the source recorded one. */
  readonly reasoning?: string
  /** Source-recorded model id for an assistant turn, when available. */
  readonly model?: string
  /** Epoch milliseconds when the source recorded the turn. */
  readonly time: number
}

/** A discovered foreign conversation, ready for conversion. */
export interface MigrationSession {
  /** Stable id in the SOURCE store (file uuid, rollout id, …). */
  readonly sourceId: string
  /** Source working directory, when recorded; falls back to the scan root. */
  readonly cwd: string
  /** Conversation title, when the source derived one. */
  readonly title?: string
  readonly startedAt: number
  readonly turns: readonly MigrationTurn[]
}

/** What one adapter found on disk. */
export interface MigrationDiscovery {
  /** Absolute roots that were scanned (reported to the user). */
  readonly roots: readonly string[]
  readonly sessions: readonly MigrationSession[]
}

/** A migration adapter for one foreign agent. */
export interface MigrationAdapter {
  readonly id: string
  readonly label: string
  /** Absolute source roots this adapter would scan on this machine. */
  roots(): readonly string[]
  /** Scan the roots and normalize every readable conversation. */
  discover(): MigrationDiscovery
  /** Cheap per-root file count for list mode (no parsing). Implementations
   *  that cannot count by name alone may omit this and fall back to
   *  discover() — the count then equals the parsed session total. */
  count?(): number
}
