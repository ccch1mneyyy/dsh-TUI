/**
 * The Agent Domain event vocabulary (docs/agent-backend-design.md §3.3): one
 * high-fidelity superset every backend translator emits and the one shared
 * projector (`src/channel/projection.ts`) consumes. Replay and live use the
 * same vocabulary; a backend that lacks a capability emits nothing for it
 * rather than a fake event.
 *
 * Identity (design §3.3 table): `seq` orders and deduplicates; `anchor` is the
 * backend's native resume/rewind anchor; `turn`/`step` position a model call;
 * `attemptId` names one streamed attempt; `callId` pairs a tool call with its
 * result.
 *
 * Pure types plus no I/O: this module imports nothing but host-plane VIEW
 * types (the UI's own vocabulary), never a vendor package.
 */
import type { AgentMessageView, ChannelGoal, TodoPanelItem, TranscriptImage } from '../adapter/ports/channel-view.js'
import type { ToolCallPresentation, ToolResultPresentation } from './presentation.js'

/**
 * Neutral view of one content block. Only `text` blocks carry text the
 * channel reads; every other kind passes through opaque (a translator may
 * hand its native block array over by reference — the projector only reads
 * `type` and `text`).
 */
export interface ContentBlockView {
  readonly type: string
  readonly text?: string
}

/** Assistant message block; `reasoning` blocks carry the thinking text. */
export type AssistantBlock = ContentBlockView

/** UI-safe lazy image facade (the attachment bytes load on demand). */
export type ImageRef = TranscriptImage

/**
 * Token usage of one model call. Fields stay optional and are copied
 * verbatim: durable history may lack a count, and "unknown" must stay
 * distinguishable from 0 (throughput falls back to a character estimate).
 */
export interface UsageDelta {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** A backend-reported session cost (Claude `total_cost_usd`). */
export interface CostReport {
  readonly amount: number
  readonly currency: string
  /** `backend` = reported by the backend; `estimate` = computed locally. */
  readonly source: 'backend' | 'estimate'
}

/**
 * Why a turn closed. `other` keeps a backend-native close reason the shared
 * vocabulary has no name for (DSH `max-tokens`, `forked`) so it still renders
 * as `turn <label>`.
 */
export type TurnEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'error'; readonly message: string; readonly category?: string }
  | { readonly kind: 'blocked'; readonly detail?: string }
  | { readonly kind: 'other'; readonly label: string }

/** One queued user input the backend has not yet claimed. */
export interface PendingItem {
  /** The channel-generated `clientMessageId` of the submission. */
  readonly id: string
  readonly text: string
  readonly placement: 'steer' | 'followup'
}

/** One option of a permission prompt, in the backend's own vocabulary. */
export interface PermissionOptionView {
  readonly id: string
  readonly kind: 'allow-once' | 'allow-always' | 'reject'
  /**
   * The backend's own wording (an allow-always option names what it would
   * remember); absent = the generic localized label of its `kind`, resolved
   * at render time so a language switch repaints it.
   */
  readonly label?: string
}

/**
 * One parked permission prompt (design §4.7). Everything but `requestId`,
 * `toolName` and `options` is optional presentation the backend may know;
 * the panel shows what is present.
 */
export interface PermissionRequestView {
  readonly requestId: string
  readonly toolName: string
  /** The gated tool call (pairs the prompt with its card). */
  readonly callId?: string
  /** The tool input as the model sent it (opaque to the UI). */
  readonly input?: Readonly<Record<string, unknown>>
  /** Short noun phrase for the action ("Write", "Read file"). */
  readonly displayName?: string
  /** Full prompt sentence when the backend renders one. */
  readonly title?: string
  /** Secondary explanation (what granting would allow). */
  readonly description?: string
  /** Why the backend asks (its decision reason). */
  readonly reason?: string
  /** One-line rendering of the gated action (command, file, URL). */
  readonly command?: string
  /** The path outside the allowed directories that triggered the ask. */
  readonly blockedPath?: string
  /** The asking subagent, when the call runs inside one. */
  readonly agentId?: string
  /** A stray keystroke must not approve: reject comes first, no one-key approve. */
  readonly defaultToNo?: boolean
  /** No persistent "don't ask again" choice may be offered. */
  readonly suppressAlwaysAllow?: boolean
  /** A user-configured ask rule forced this prompt (no allow-always either). */
  readonly matchedAskRule?: { readonly source: string; readonly toolName: string; readonly ruleContent?: string }
  /** The MCP server serving an `mcp__*` tool (untrusted display text). */
  readonly mcpServer?: { readonly name: string; readonly source: string }
  /** A rejection may carry the user's free-text reason back to the model. */
  readonly feedback?: boolean
  readonly options: readonly PermissionOptionView[]
}

/** How a permission prompt settled. */
export type PermissionOutcome = 'allow-once' | 'allow-always' | 'rejected' | 'cancelled'

/**
 * A plan-review presentation of one question (the decision-card panel):
 * `approve` and every `approveAlso` label approve (a clean answer, never with
 * feedback); `decline` names the keep-planning option a feedback answer
 * selects (absent = the first option that does not approve).
 */
export interface PlanReviewIntentView {
  readonly kind: 'plan-review'
  readonly approve: string
  readonly approveAlso?: readonly string[]
  readonly decline?: string
}

/** One question of a structured ask (`ask_user_question` / `AskUserQuestion`). */
export interface QuestionItemView {
  readonly question: string
  readonly header?: string
  /** Long-form body (a plan under review). */
  readonly detail?: string
  readonly options: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
  readonly intent?: PlanReviewIntentView
  /** Only the options answer it (no free-text row). */
  readonly hideCustomInput?: boolean
  /** Option labels selected / focused when the question first shows. */
  readonly defaultSelected?: readonly string[]
  /** A URL the question is about (rendered as a link where supported). */
  readonly link?: string
}

/** One parked structured ask. */
export interface QuestionRequestView {
  readonly requestId: string
  readonly callId?: string
  readonly agentId?: string
  readonly questions: readonly QuestionItemView[]
}

/** Token usage a subagent reported. */
export interface SubagentUsage {
  readonly input?: number
  readonly output?: number
  /** All tokens the subagent consumed so far (when only a total is known). */
  readonly total?: number
  readonly toolUses?: number
  readonly durationMs?: number
}

/** Background task lifecycle state. */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped'

/** One backend command (slash-menu entry). */
export interface CommandInfo {
  readonly name: string
  readonly description?: string
  readonly argumentHint?: string
}

/** Subscription / rate-limit utilisation windows. */
export interface RateLimitView {
  readonly windows: readonly { readonly name: string; readonly utilization: number; readonly resetsAt?: number }[]
}

/** A goal snapshot as a backend records it (the channel owns `roundsStarted`). */
export type GoalSnapshot = Omit<ChannelGoal, 'roundsStarted'>

/** Every Agent Domain event. */
export type AgentEvent =
  // ── session ──────────────────────────────────────────────────────────
  /** The session is open: identity, cwd and the starting configuration. */
  | { readonly type: 'session.ready'; readonly sessionId: string; readonly cwd: string; readonly model: string; readonly provider?: string; readonly title?: string; readonly permissionMode?: string; readonly effort?: string; readonly contextWindow?: number; readonly backendVersion?: string }
  /** The session title changed (`user` = renamed by the user; `auto` = generated). */
  | { readonly type: 'session.title'; readonly title: string; readonly source: 'user' | 'auto' }
  /** The session accent colour changed; `''` clears to the default. */
  | { readonly type: 'session.color'; readonly color: string }
  /** The backend reset the conversation in place (Claude `conversation_reset`). */
  | { readonly type: 'session.reset'; readonly trigger: string }
  /** The backend's session status changed. */
  | { readonly type: 'session.status'; readonly status: 'idle' | 'running' | 'requires-action' | 'disposed' }
  // ── turns and steps ─────────────────────────────────────────────────
  /** A turn opened. */
  | { readonly type: 'turn.start'; readonly turn: number; readonly origin: 'user' | 'system' | 'notification'; readonly userMessageId?: string; readonly time: number }
  /** A turn closed. */
  | { readonly type: 'turn.end'; readonly turn: number; readonly reason: TurnEndReason; readonly time: number; readonly usage?: UsageDelta; readonly cost?: CostReport }
  /** A step (one model call plus its tools) opened. */
  | { readonly type: 'step.start'; readonly turn: number; readonly step: number }
  /** A step closed. */
  | { readonly type: 'step.end'; readonly turn: number; readonly step: number }
  // ── user side ───────────────────────────────────────────────────────
  /**
   * A user-role message reached the durable record. `text` is the
   * transcript-facing text (the first text block for `user`, the summary for
   * `compaction`); `blocks` is everything the model saw. `injected` messages
   * (plugin/skill context) never render as bubbles.
   */
  | { readonly type: 'user.message'; readonly id: string; readonly anchor: string; readonly seq: number; readonly turn?: number; readonly time: number; readonly source: 'user' | 'injected' | 'goal' | 'compaction' | 'command-output' | 'notification'; readonly text: string; readonly blocks: readonly ContentBlockView[]; readonly images?: readonly ImageRef[]; readonly label?: string }
  /**
   * Snapshot of the backend's queue of unclaimed user inputs (REPLACE
   * semantics). `claimed`/`discarded` name the ids that left the queue in this
   * change: a claimed input became part of a turn, a discarded one never will
   * (its channel-side companions must be dropped too).
   */
  | { readonly type: 'pending.changed'; readonly items: readonly PendingItem[]; readonly claimed?: readonly string[]; readonly discarded?: readonly string[] }
  // ── assistant stream ────────────────────────────────────────────────
  /** A streamed attempt opened at (turn, step); a still-open earlier attempt is superseded. */
  | { readonly type: 'assistant.attempt.start'; readonly attemptId: string; readonly turn: number; readonly step: number; readonly model?: string; readonly parentCallId?: string }
  /**
   * One stream delta. Live deltas route by `attemptId` (a delta of an attempt
   * the projector never saw open adopts the open step — the reattach case);
   * positioned deltas (`seq` + `turn`/`step`, legacy durable chunks) apply to
   * that step directly and are deduplicated by `seq`. `other` marks a
   * non-content stream record (block boundary, usage, finish).
   */
  | { readonly type: 'assistant.delta'; readonly attemptId: string; readonly index: number; readonly time: number; readonly parentCallId?: string; readonly turn?: number; readonly step?: number; readonly seq?: number
      readonly delta:
        | { readonly kind: 'text'; readonly text: string }
        | { readonly kind: 'reasoning'; readonly text: string }
        | { readonly kind: 'reasoning-tokens'; readonly estimated: number }
        | { readonly kind: 'tool-args'; readonly callId: string; readonly partialJson: string; readonly name?: string }
        | { readonly kind: 'other' } }
  /**
   * A streamed attempt closed. `abandoned`/`aborted` drop its provisional
   * rows. With `turn`/`step` the end is a durable record located by position
   * (DSH `assistant/attempt`): it discards that step even when no live attempt
   * matched; without them it settles the matching live attempt only.
   */
  | { readonly type: 'assistant.attempt.end'; readonly attemptId: string; readonly outcome: 'committed' | 'abandoned' | 'aborted'; readonly turn?: number; readonly step?: number }
  /**
   * A settled assistant message. `canonical` = the blocks are the complete
   * record of the attempt (provisional content they omit is removed);
   * `turn`/`step` are absent only on legacy history that predates them.
   */
  | { readonly type: 'assistant.message'; readonly seq: number; readonly anchor: string; readonly turn?: number; readonly step?: number; readonly attemptId: string; readonly time: number; readonly model?: string; readonly blocks: readonly AssistantBlock[]; readonly images?: readonly ImageRef[]; readonly usage?: UsageDelta; readonly interrupted?: true; readonly canonical: boolean; readonly parentCallId?: string }
  // ── tools ───────────────────────────────────────────────────────────
  /** A tool call was issued. */
  | { readonly type: 'tool.call'; readonly seq: number; readonly anchor?: string; readonly turn: number; readonly step: number; readonly callId: string; readonly name: string; readonly argsJson: string; readonly parentCallId?: string; readonly agentId?: string; readonly presentation?: ToolCallPresentation; readonly time: number }
  /**
   * A tool call settled. `text` is the result's text blocks joined (the body
   * a card shows); `errorText` is set exactly when `isError`.
   */
  | { readonly type: 'tool.result'; readonly seq: number; readonly turn: number; readonly step: number; readonly callId: string; readonly isError: boolean; readonly time: number; readonly content: readonly ContentBlockView[]; readonly text: string; readonly errorText?: string; readonly images?: readonly ImageRef[]; readonly structured?: unknown; readonly meta?: unknown; readonly presentation?: ToolResultPresentation; readonly parentCallId?: string }
  /** A running tool reported progress. */
  | { readonly type: 'tool.progress'; readonly callId: string; readonly elapsedMs: number; readonly parentCallId?: string }
  // ── human in the loop ───────────────────────────────────────────────
  /** A permission prompt is waiting for the user. */
  | { readonly type: 'permission.request'; readonly request: PermissionRequestView }
  /** A permission prompt settled. */
  | { readonly type: 'permission.settled'; readonly requestId: string; readonly outcome: PermissionOutcome }
  /** A structured ask is waiting for the user. */
  | { readonly type: 'question.request'; readonly request: QuestionRequestView }
  /** A structured ask settled (answered or cancelled). */
  | { readonly type: 'question.settled'; readonly requestId: string }
  // ── subagents and background tasks ──────────────────────────────────
  /**
   * A subagent started. `parentCallId` names the delegating tool call (its
   * lane: child-lane events carry it as their `parentCallId`). A second start
   * for the same lane completes the first: a backend that learns the
   * subagent's own id after the call (Claude: `task_started` follows the
   * `Agent` tool call) re-keys the lane's subagent to the new `agentId`.
   * `depth` = spawn nesting (1 = spawned by the main loop).
   * `parentAgentId` = the agent that spawned this child, when the backend
   * can state it as a fact (Claude resume: `parent_agent_id` from the disk
   * transcript, or the transcript the delegating call sits in). Absent =
   * the parent is not known YET — depth 1 still proves a main-loop child,
   * and nothing may infer a parent from depth alone (design agent-team
   * §2: the tree only trusts real parent facts).
   */
  | { readonly type: 'subagent.start'; readonly agentId: string; readonly parentCallId?: string; readonly parentAgentId?: string; readonly description: string; readonly kind?: string; readonly model?: string; readonly background: boolean; readonly depth?: number; readonly time: number }
  /** A subagent reported progress. */
  | { readonly type: 'subagent.progress'; readonly agentId: string; readonly summary?: string; readonly lastTool?: string; readonly usage?: SubagentUsage }
  /** A subagent finished. */
  | { readonly type: 'subagent.end'; readonly agentId: string; readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown'; readonly summary?: string; readonly usage?: SubagentUsage; readonly time: number }
  /**
   * A background task started. `callId` names the tool call whose result
   * acknowledged it; `command` is the full invocation when known. `hidden`
   * = housekeeping work the backend says is not activity (no card, no
   * activity chip, no settlement toast).
   */
  | { readonly type: 'task.start'; readonly taskId: string; readonly kind: string; readonly description: string; readonly command?: string; readonly callId?: string; readonly background: boolean; readonly outputFile?: string; readonly hidden?: boolean; readonly time: number }
  /**
   * A background task changed. `outputFile` = where the task writes its
   * output (as the backend reported it; readers validate it); `progress` = a
   * one-line live status.
   */
  | { readonly type: 'task.update'; readonly taskId: string; readonly patch: { readonly status?: TaskStatus; readonly description?: string; readonly error?: string; readonly background?: boolean; readonly outputFile?: string; readonly progress?: string } }
  /** Output of a background task was observed (`callId` = the tool call that read it). */
  | { readonly type: 'task.output'; readonly taskId: string; readonly text: string; readonly time: number; readonly callId?: string }
  /** A background task finished. */
  | { readonly type: 'task.end'; readonly taskId: string; readonly status: 'completed' | 'failed' | 'stopped'; readonly summary?: string; readonly outputFile?: string; readonly time: number }
  /** The complete set of live background tasks (REPLACE semantics). */
  | { readonly type: 'tasks.snapshot'; readonly taskIds: readonly string[] }
  // ── context and modes ───────────────────────────────────────────────
  /** A context compaction started (`cancellable` only for one this process may abort). */
  | { readonly type: 'compaction.start'; readonly trigger: 'manual' | 'auto'; readonly cancellable: boolean; readonly time: number }
  /** The compaction model call produced `outputChars` more characters. */
  | { readonly type: 'compaction.progress'; readonly outputChars: number }
  /** A compaction closed (committed or abandoned). */
  | { readonly type: 'compaction.end'; readonly ok: boolean; readonly summary?: string; readonly preTokens?: number; readonly postTokens?: number; readonly error?: string; readonly time: number }
  /** The model's context window is known. */
  | { readonly type: 'context.capacity'; readonly contextWindow: number }
  /** Backend-measured context usage. */
  | { readonly type: 'context.usage'; readonly used: number; readonly max?: number; readonly categories?: readonly { readonly name: string; readonly tokens: number; readonly kind: string }[] }
  /** The session's model changed. */
  | { readonly type: 'model.changed'; readonly model: string; readonly provider?: string; readonly source: 'user' | 'fallback' | 'resume' | 'settings' }
  /** The reasoning effort changed (`null` = backend default). */
  | { readonly type: 'effort.changed'; readonly effort: string | null }
  /** The backend-native mode (permission mode) changed. */
  | { readonly type: 'mode.changed'; readonly modeId: string }
  /** The backend's command list changed. */
  | { readonly type: 'commands.changed'; readonly commands: readonly CommandInfo[] }
  /**
   * A goal mutation (DSH native). `operation: 'round'` only advances the
   * admitted-round counter to `round`; `clear` drops the goal; any other
   * operation with a `goal` replaces the snapshot (`roundsStarted` absent =
   * keep the current count).
   */
  | { readonly type: 'goal.change'; readonly goal?: GoalSnapshot; readonly operation: string; readonly roundsStarted?: number; readonly round?: number }
  /** The latest todo-list snapshot. */
  | { readonly type: 'todo.write'; readonly items: readonly TodoPanelItem[] }
  /**
   * An agent preset was selected (DSH native). `aliases` are names that denote
   * the same preset, so a transcript recorded under an older name shows the
   * user's current spelling.
   */
  | { readonly type: 'preset.selected'; readonly preset: string; readonly aliases?: readonly string[] }
  /** The active system prompt text (an empty text clears it). */
  | { readonly type: 'system.prompt'; readonly text: string }
  /**
   * The request configuration of the next model call (DSH `request/header`):
   * the model usage is attributed to (absent = unknown, fall back to the
   * session model) and the reasoning effort when stated.
   */
  | { readonly type: 'request.header'; readonly model?: string; readonly effort?: string }
  // ── agent-to-agent messages (design agent-team-full §5.4) ─────────────
  /**
   * An agent↔agent relay OBSERVATION: a Claude parent's SendMessage tool
   * call/result, emitted by the backend translator as the call streams and
   * again when its result settles (same `message.messageId`; the state only
   * advances — an unrecognized result is 'unknown', never a guessed
   * delivery). DSH relay sources fold adapter-side straight from the durable
   * session events, so they emit no event here.
   */
  | { readonly type: 'agent.message'; readonly message: AgentMessageView }
  // ── notices ─────────────────────────────────────────────────────────
  /** A backend notice for the user. */
  | { readonly type: 'notice'; readonly level: 'info' | 'notice' | 'warning' | 'error'; readonly text: string; readonly key?: string; readonly callId?: string }
  /** Subscription / rate-limit utilisation changed. */
  | { readonly type: 'rate-limit'; readonly info: RateLimitView }
  /** A backend-native event the vocabulary has no name for (plugin renderer seam). */
  | { readonly type: 'custom'; readonly nativeType: string; readonly data: unknown }

/** The `type` tag of every event. */
export type AgentEventType = AgentEvent['type']

/** Narrow the union to one variant. */
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { readonly type: T }>

/** Batch metadata: `replay` = settled history being repainted, not live. */
export interface AgentEventMeta {
  readonly replay: boolean
  /**
   * How urgently the channel should publish the batch: `sync` (a durable
   * change, the default), `frame` (high-frequency stream data, coalesced to
   * the next render frame), `none` (nothing renderer-visible by itself). A
   * backend knows which of its inputs are token-rate; an empty batch still
   * carries its source's wake.
   */
  readonly wake?: 'sync' | 'frame' | 'none'
}

/** Shared empty batch (translators return it when an input maps to nothing). */
export const NO_EVENTS: readonly AgentEvent[] = Object.freeze([])
