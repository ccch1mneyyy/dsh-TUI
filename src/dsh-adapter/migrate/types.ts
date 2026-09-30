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

/**
 * One message of a foreign conversation as a flat role list — the shape the
 * omp adapter still produces; {@link fromRoleTurns} in parse/role-turns.ts
 * folds it into {@link ImportTurn}s.
 */
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

/** One assistant content block of an imported step. */
export type ImportBlock =
  | { readonly type: 'text', readonly text: string }
  | { readonly type: 'reasoning', readonly text: string }
  | { readonly type: 'tool-call', readonly id: string, readonly name: string, readonly arguments: string }

/** The model-facing result of one tool call, paired by call id. */
export interface ImportToolResult {
  readonly callId: string
  /** Result text; images are replaced by a placeholder, oversize text is clamped. */
  readonly text: string
  readonly isError: boolean
}

/** One model call and the tool executions it requested. */
export interface ImportStep {
  /** User-role messages entering this step before the model answers (mid-turn
   *  context such as skill bodies or image notes — never the turn's prompt). */
  inputs: string[]
  blocks: ImportBlock[]
  /** Results for this step's tool-call blocks; after closeToolPairs() exactly
   *  one per call, in call order. */
  results: ImportToolResult[]
  /** Source-recorded model id for this step, when available. */
  model?: string
}

/** A context-compaction boundary the source recorded before a turn. */
export interface ImportCompaction {
  readonly summary: string
  readonly model?: string
}

/** One imported turn: a human prompt and the steps that answered it. */
export interface ImportTurn {
  /** The human prompt; '' when the turn has none (source lost its head, or
   *  the turn only carries a compaction checkpoint). */
  prompt: string
  /** A compaction checkpoint emitted BEFORE this turn opens. */
  compaction?: ImportCompaction
  steps: ImportStep[]
  /** The source recorded this turn as interrupted. */
  aborted?: boolean
}

/** Per-conversation counters for what parsing had to leave out. */
export interface ImportStats {
  /** Lines that were not valid JSON. */
  badLines: number
  /** Tool results with no matching call, or a second result for one call. */
  droppedToolResults: number
  /** Rows left out: harness injection in the user role, local-command
   *  echoes, provider-side tool rows with no harness counterpart. */
  filtered: number
  /** Mid-turn machine context folded into a step's inputs (Claude isMeta, …). */
  meta: number
}

/** A discovered foreign conversation, ready for conversion. */
export interface MigrationSession {
  /** Stable id in the SOURCE store (file uuid, rollout id, …). */
  readonly sourceId: string
  /** Source working directory, when recorded; falls back to the scan root. */
  readonly cwd: string
  /** Conversation title, when the source has one (possibly a first-prompt fallback). */
  readonly title?: string
  /** Whether {@link title} is the source's own title (written to the log as
   *  `session/title`) rather than a first-prompt fallback (left for DSH to derive). */
  readonly titleExplicit: boolean
  readonly startedAt: number
  readonly turns: readonly ImportTurn[]
  readonly stats: ImportStats
}

/** What one adapter found on disk. */
export interface MigrationDiscovery {
  /** Absolute roots that were scanned (reported to the user). */
  readonly roots: readonly string[]
  readonly sessions: readonly MigrationSession[]
}

/** Change token of one source artifact: unchanged means reuse its summary. */
export interface Fingerprint {
  readonly mtimeMs: number
  readonly size: number
}

/** A foreign conversation as listed, derived from the head (and tail) of
 *  its artifact and stat alone — never from a full parse. */
export interface ForeignSessionSummary {
  readonly agentId: string
  /** Stable source id; always equals the `sourceId` a full parse yields, so
   *  both import entries land on the same deterministic session id. */
  readonly sessionKey: string
  /** Opaque locator of the full content (file path / session directory). */
  readonly ref: string
  /** Normalized title; possibly the first-prompt fallback. */
  readonly title: string
  /** '' when unknown. */
  readonly cwd: string
  /** Sort key: when the conversation last changed. */
  readonly lastMessageAt: number
  readonly createdAt: number
}

/** One scanned artifact: its summary, or null when it is not a conversation
 *  of its own (sub-agent log, no prompt) — negative results are cached too. */
export interface ScanEntry {
  readonly ref: string
  readonly fp: Fingerprint
  readonly summary: ForeignSessionSummary | null
}

export interface ScanOptions {
  readonly signal?: AbortSignal
  /** A previous result for an unchanged artifact: a summary, null (known not
   *  to be a conversation), or undefined (unknown — read it). */
  cached?(ref: string, fp: Fingerprint): ForeignSessionSummary | null | undefined
  /** Called per conversation as the scan finds it. */
  onEntry?(summary: ForeignSessionSummary): void
}

/** Where a source's artifacts sit under its roots, by name alone. */
export interface WalkSpec {
  readonly maxDepth: number
  readonly match: (name: string) => boolean
  /** Directory names never descended into. */
  readonly skipDirs?: readonly string[]
}

/** Why a full load produced no session. */
export interface LoadSkip {
  readonly skip: 'missing' | 'too-large' | 'not-a-session'
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
  /** The name-only walk scan() follows; lets a caller count candidates and
   *  find the newest activity without parsing. Present with scan(). */
  readonly walk?: WalkSpec
  /** Asynchronous, abortable summary scan for browsing (head/tail reads,
   *  fingerprint reuse). Sources without it are not browsable. */
  scan?(options?: ScanOptions): Promise<readonly ScanEntry[]>
  /** Full parse of one conversation found by scan(). */
  load?(ref: string): Promise<MigrationSession | LoadSkip>
}
