/**
 * Typed optional session capabilities (docs/agent-backend-design.md §3.4).
 * Every member is optional: absence means the backend does not support it,
 * and the channel says so explicitly instead of a silent no-op.
 *
 * `native` is the escape hatch for specialists that are not
 * capability-shaped yet. The marker interfaces below carry no vendor types;
 * each backend augments its own marker from inside its directory, and only
 * that directory may read it (enforced by `verify:boundary`).
 */
import type { AgentEvent, CommandInfo, PermissionRequestView } from './events.js'
import type { AgentSessionRef } from './refs.js'

/** DSH escape hatch; augmented by `src/dsh-adapter/backend/session.ts`. */
export interface DshNative {
  readonly kind: 'dsh'
}

/** Claude Agent SDK escape hatch; augmented by `src/backends/claude/`. */
export interface ClaudeNative {
  readonly kind: 'claude'
}

/** ACP escape hatch; augmented by `src/backends/acp/`. */
export interface AcpNative {
  readonly kind: 'acp'
}

/** A user decision on one permission prompt. */
export type PermissionDecision =
  | { readonly kind: 'allow-once' }
  | { readonly kind: 'allow-always' }
  | { readonly kind: 'reject'; readonly message?: string }

/** Answers to one structured ask, by question order. */
export interface QuestionAnswers {
  readonly answers: readonly { readonly selected: readonly string[]; readonly custom?: string }[]
}

/** A selectable model. */
export interface ModelOption {
  readonly provider?: string
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** A model reference. */
export interface ModelRef {
  readonly provider?: string
  readonly model: string
}

/** What a model switch did. */
export type ModelSwitchOutcome =
  | { readonly kind: 'switched' }
  | { readonly kind: 'refused'; readonly reason: string }

/** A selectable reasoning-effort level. */
export interface EffortOption {
  readonly id: string
  readonly label: string
}

/** A selectable backend-native mode. */
export interface ModeOption {
  readonly id: string
  readonly label: string
}

/** What a rewind would change. */
export interface RewindPreview {
  readonly filesChanged: readonly string[]
  readonly insertions?: number
  readonly deletions?: number
}

/** What a rewind did. */
export type RewindOutcome =
  | { readonly kind: 'rewound'; readonly session: AgentSessionRef }
  | { readonly kind: 'refused'; readonly reason: string }

/** One MCP server's status. */
export interface McpServerView {
  readonly name: string
  readonly status: string
  readonly toolCount?: number
}

/** What running a backend command did. */
export type ExternalCommandOutcome =
  | { readonly kind: 'handled' }
  | { readonly kind: 'failed'; readonly reason: string }

/** Backend-measured context usage. */
export interface ContextUsageView {
  readonly used: number
  readonly max?: number
  readonly categories: readonly { readonly name: string; readonly tokens: number; readonly kind: string }[]
}

/** Signed-in account summary. */
export interface AccountView {
  readonly organization?: string
  readonly subscription?: string
  readonly provider?: string
}

/** What a fresh conversation loads (system prompt sections, files, skills). */
export interface LoadedContextView {
  readonly sections: readonly { readonly name: string; readonly text: string }[]
}

/** Every optional capability of one live session. */
export interface SessionCapabilities {
  /**
   * The backend can withdraw a queued input synchronously: `removePending`
   * answers with a plain boolean. Absent = queued inputs cannot be retracted,
   * and the channel never starts a withdrawal (Alt+Up keeps the message
   * queued instead of racing an async removal it would report as failed).
   */
  readonly retractPending?: true
  readonly permissions?: {
    respond(requestId: string, decision: PermissionDecision): void
    pending(): readonly PermissionRequestView[]
  }
  readonly questions?: {
    respond(requestId: string, answers: QuestionAnswers): void
    cancel(requestId: string): void
  }
  readonly models?: {
    list(): Promise<readonly ModelOption[]>
    current(): ModelRef
    set(ref: ModelRef): Promise<ModelSwitchOutcome>
  }
  readonly effort?: {
    levels(): readonly EffortOption[]
    current(): string | undefined
    set(id: string | null): Promise<void>
  }
  readonly modes?: {
    list(): readonly ModeOption[]
    current(): string
    set(id: string): Promise<void>
  }
  readonly compact?: { run(): Promise<void>; cancel?(): void }
  readonly rewind?: {
    preview?(anchor: string): Promise<RewindPreview>
    rewind(anchor: string, mode: 'conversation' | 'files' | 'both'): Promise<RewindOutcome>
  }
  readonly fork?: { fork(anchor?: string, title?: string): Promise<AgentSessionRef> }
  readonly subagents?: {
    interrupt(agentId: string): Promise<boolean>
    history?(agentId: string): Promise<readonly AgentEvent[]>
  }
  readonly tasks?: { stop(taskId: string): Promise<boolean>; readOutput?(taskId: string): Promise<string> }
  readonly mcp?: {
    status(): Promise<readonly McpServerView[]>
    reconnect?(name: string): Promise<void>
    toggle?(name: string, enabled: boolean): Promise<void>
  }
  readonly commands?: {
    list(): Promise<readonly CommandInfo[]>
    run?(name: string, rawInput: string): Promise<ExternalCommandOutcome | undefined>
  }
  readonly context?: { usage(detail: 'summary' | 'full'): Promise<ContextUsageView> }
  readonly account?: { info(): Promise<AccountView> }
  readonly loadedContext?: { snapshot(): Promise<LoadedContextView | undefined> }
  /** Backend-specific `/doctor` lines (version drift, executable, …), already
   *  localized by the backend. */
  readonly diagnostics?: { lines(): readonly string[] }
  /** Backend escape hatches; read only from the owning backend's directory. */
  readonly native: { readonly dsh?: DshNative; readonly claude?: ClaudeNative; readonly acp?: AcpNative }
}
