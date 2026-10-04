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
import type { AgentMessageView, WorkingActivityView } from '../adapter/ports/channel-view.js'
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
  /** `optionId` picks one allow-always option when the prompt offers several. */
  | { readonly kind: 'allow-always'; readonly optionId?: string }
  /** `message` is the user's own reason, relayed to the model. */
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
  /** One line saying what the mode does (the picker's second row); absent
   *  when the backend has nothing to add. */
  readonly description?: string
}

/**
 * One relay channel profile (the Claude backend's channels.json): the exact
 * `models` map and the `tiers` rules that say which model actually serves
 * a requested id (backends/claude/channels.ts). Read-only rows for the
 * /channel picker, its mapping view, and the phase-3 connection-change
 * restart decision.
 */
export interface ChannelProfileView {
  readonly id: string
  readonly name: string
  /** Exact requested-id → actual model, in file order. */
  readonly models: readonly { readonly from: string; readonly to: string }[]
  /** Tier keyword → actual model, in file order (`default` = any-model rule). */
  readonly tiers: readonly { readonly tier: string; readonly to: string }[]
  /** The phase-3 connection truth (endpoint + credential presence +
   *  channel-private env KEYS — never a token literal); absent on
   *  mapping-only channels. `fingerprint` names the whole connection
   *  (endpoint + token + env) without exposing any secret: equal
   *  fingerprints are the SAME connection — switching between them needs
   *  no restart. */
  readonly connection?: {
    readonly baseUrl?: string
    readonly hasToken: boolean
    readonly envKeys: readonly string[]
    readonly fingerprint: string
  }
}

/**
 * The limits a backend takes images under (the composer's limit model:
 * the media types it accepts, per-image and per-message bytes, images per
 * message, and the per-side / total pixel caps the ingress gate resamples
 * into).
 */
export interface ImageLimitsView {
  readonly mediaTypes: readonly string[]
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly maxImageDimension: number
  readonly maxImagePixels: number
}

/** What a rewind would change. */
export interface RewindPreview {
  readonly filesChanged: readonly string[]
  readonly insertions?: number
  readonly deletions?: number
}

/**
 * What a rewind did. `session` is the conversation to continue in: a new
 * session (the backend's fork cut before the picked message) when the
 * conversation was rewound — the channel opens and adopts it — or the bound
 * session itself after a files-only rewind. `files` is what the file restore
 * changed, when files were restored.
 */
export type RewindOutcome =
  /** `conversationError`: the files were restored but the conversation
   *  rewind then failed (`session` is the bound one) — a partial outcome the
   *  user must hear about, never one reported as nothing done. */
  | { readonly kind: 'rewound'; readonly session: AgentSessionRef; readonly files?: RewindPreview; readonly conversationError?: string }
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

/** One named context contributor and its token cost. */
export interface ContextItemView {
  readonly name: string
  readonly tokens: number
}

/** Backend-measured context usage. */
export interface ContextUsageView {
  readonly used: number
  readonly max?: number
  readonly categories: readonly { readonly name: string; readonly tokens: number; readonly kind: string }[]
  /** System prompt sections. */
  readonly sections?: readonly ContextItemView[]
  /** Instruction / memory files loaded for the cwd. */
  readonly files?: readonly { readonly path: string; readonly tokens: number }[]
  /** Skills whose descriptions are in context. */
  readonly skills?: readonly ContextItemView[]
  /** Tools in context (`server` for MCP tools). */
  readonly tools?: readonly (ContextItemView & { readonly server?: string })[]
}

/** Signed-in account summary (never an email address). */
export interface AccountView {
  readonly organization?: string
  readonly subscription?: string
  readonly provider?: string
  /** Where the credential the backend uses comes from (backend vocabulary). */
  readonly tokenSource?: string
  readonly apiKeySource?: string
}

/** The credential a session runs on and how to renew it. */
export interface SessionAuthView {
  /** Localized lines for `/login` (source, account; never token material). */
  readonly lines: readonly string[]
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
    /** The display name of the model that actually serves the session when
     *  a channel mapping says the live id is a cosmetic alias (relay
     *  channels echo the requested id back — backends/claude/modelEnv.ts).
     *  Undefined = the id itself is the truth; presenters render it instead
     *  of the id, data surfaces (attribution, matching) keep the id. */
    display?(): string | undefined
  }
  readonly effort?: {
    /** Read-only bit: `levels()` serves the CLI-standard compatibility
     *  tiers (low → max) because the current model row declares no level
     *  list of its own — the relay-channel custom-row shape. The CLI
     *  accepts any effortLevel flag regardless, so the honest answer is
     *  the standard ladder, marked here so the picker can say so.
     *  Undefined = the list is the model's own (or there is no list). */
    readonly levelsFallback?: true
    levels(): readonly EffortOption[]
    current(): string | undefined
    set(id: string | null): Promise<void>
  }
  readonly modes?: {
    list(): readonly ModeOption[]
    /**
     * The mode surface the Shift+Tab reflex key may walk. Absent = the
     * cycle walks `list()` unchanged. A backend MAY declare a cycle that
     * is narrower than `list()`: a mode that must only ever be entered by
     * an explicit pick (Claude's `bypassPermissions` in the /permission
     * picker) stays out of the cycle, so one reflexive keypress can never
     * land in it. The narrowing is declared here, in the capability layer —
     * the UI never hardcodes mode names to shape the cycle.
     */
    cycle?(): readonly ModeOption[]
    current(): string
    set(id: string): Promise<void>
  }
  /**
   * The backend's relay channel profiles (the Claude backend's channels.json):
   * the /channel picker's roster, the active pick (whose mapping the model
   * display resolves through), and the settings import. Synchronous by
   * contract — the store is a small best-effort file (prefs.ts's model).
   */
  readonly channels?: {
    list(): readonly ChannelProfileView[]
    /** The active channel's id; undefined when none is active. */
    activeId(): string | undefined
    /** Switch the active channel (persists; a no-op for an unknown id). */
    setActive(id: string): void
    /** Import/refresh the channel profile hiding in the CLI settings env;
     *  undefined when the env holds nothing importable. Phase 3: the
     *  connection (base URL + auth token) is absorbed too — the token
     *  moves into the credential store, the profile keeps only its ref. */
    importFromSettings(): ChannelProfileView | undefined
    /** Upsert one profile with connection fields (the phase-3 wizard): a
     *  given token goes to the credential seam, the profile keeps only its
     *  ref. Absent on backends without the management surface. */
    save?(input: {
      readonly id: string
      readonly name: string
      /** Undefined = keep the stored field; '' clears it. */
      readonly baseUrl?: string
      /** Undefined = keep the stored token; '' removes it (and its ref). */
      readonly token?: string
      /** Undefined = keep; a provided record replaces the whole map. */
      readonly env?: Readonly<Record<string, string>>
      readonly models?: Readonly<Record<string, string>>
      readonly tiers?: Readonly<Record<string, string>>
    }): ChannelProfileView
    /** Drop one profile (and its stored token); false for an unknown id. */
    remove?(id: string): boolean
    /** What the CLI settings env holds for an import (phase-3 wizard): the
     *  base URL and the absorbable tier rules, without creating anything. */
    peekSettingsImport?(): { readonly baseUrl?: string; readonly tiers: Readonly<Record<string, string>> } | undefined
  }
  readonly compact?: { run(): Promise<void>; cancel?(): void }
  /**
   * Rewind to a user message (`anchor` = its `user.message.anchor`):
   * `preview` reports what restoring the files would change (throws when
   * they cannot be restored); `rewind` restores files, the conversation, or
   * both (files first).
   */
  readonly rewind?: {
    preview?(anchor: string): Promise<RewindPreview>
    rewind(anchor: string, mode: 'conversation' | 'files' | 'both'): Promise<RewindOutcome>
  }
  /** A persisted copy of the session (through `anchor`, inclusive, when
   *  given); the live session is untouched. */
  readonly fork?: { fork(anchor?: string, title?: string): Promise<AgentSessionRef> }

  /** Subagents: stop one by the id the channel knows it by, or read one
   *  child's own transcript from the durable store. */
  readonly subagents?: {
    interrupt(agentId: string): Promise<boolean>
    /** The child's own full transcript from the backend's durable store
     *  (design agent-team-panels §2: history = getSubagentMessages → the
     *  replay/translator → AgentEvent). Absent = the backend has no
     *  transcript data source; rejects when the read fails. */
    history?(agentId: string, window?: SubagentTranscriptWindow): Promise<SubagentTranscriptPage>
    /**
     * The session's own relay observations (design agent-team-full §5.4:
     * Claude folds its SendMessage tool traffic into neutral views). The
     * channel core composes the parent-mediated submit path around it;
     * absent = this backend serves no message capability (the composer is
     * not rendered).
     */
    message?: { messages(): readonly AgentMessageView[] }
  }
  /**
   * Background tasks: `stop` asks the backend to stop one; `readOutput`
   * reads the tail of its output (bounded by the backend; rejects when the
   * task has no readable output).
   */
  readonly tasks?: { stop(taskId: string): Promise<boolean>; readOutput?(taskId: string): Promise<string> }
  /**
   * The durable record behind "load earlier" (design §4.11): read-only,
   * synchronous and bounded (a user click waits for it).
   * `record()` replays everything the backend persisted for the bound
   * session — the source folded rows are restored from (rows match by their
   * stable anchors: user / assistant `anchor`, tool `callId`); undefined when
   * it cannot be read now. `older()` returns the next slice older than what
   * `history()` replayed (history a compaction cut off), oldest first, and
   * advances past it — an empty slice when nothing older remains;
   * `hasOlder()` says whether one may still exist.
   */
  readonly transcript?: {
    record(): readonly AgentEvent[] | undefined
    hasOlder(): boolean
    older(): readonly AgentEvent[]
  }
  readonly mcp?: {
    status(): Promise<readonly McpServerView[]>
    reconnect?(name: string): Promise<void>
    toggle?(name: string, enabled: boolean): Promise<void>
  }
  /**
   * One tool-less, single-answer side call over the current conversation
   * (`/btw`, `/recap`): nothing it does enters the session's record. The
   * answer streams to `onText`; `answer: null` without an `error` = the
   * caller aborted.
   */
  readonly sideQuery?: {
    ask(prompt: string, options?: { readonly signal?: AbortSignal; readonly onText?: (delta: string) => void }): Promise<{ readonly answer: string | null; readonly error?: string }>
  }
  /** Rename the session (persisted by the backend; reported as a
   *  `session.title{source:'user'}` event). */
  readonly rename?: { rename(title: string): Promise<void> }
  /** The session's accent colour (`/color`), kept per session; reported as
   *  a `session.color` event ('' = the theme default). */
  readonly color?: { current(): string; set(color: string): void }
  /**
   * The backend takes images in the message itself (Claude: base64 blocks):
   * the channel stages pasted and `@`-mentioned images in memory under these
   * limits instead of the DSH attachments service, and hands their facades
   * to `submit` as `AgentInput.images`, in block order.
   */
  readonly images?: { readonly limits: ImageLimitsView }
  readonly commands?: {
    list(): Promise<readonly CommandInfo[]>
    run?(name: string, rawInput: string): Promise<ExternalCommandOutcome | undefined>
  }
  readonly context?: { usage(detail: 'summary' | 'full'): Promise<ContextUsageView> }
  readonly account?: { info(): Promise<AccountView> }
  /**
   * The session's sign-in: `/login` shows `status()`, then offers the host's
   * OAuth sign-in for `oauthProvider` and `reconnect()`s so the next turn
   * runs on the fresh credential.
   */
  readonly auth?: {
    readonly oauthProvider?: string
    status(): Promise<SessionAuthView>
    reconnect(): Promise<void>
  }
  readonly loadedContext?: { snapshot(): Promise<LoadedContextView | undefined> }
  /**
   * The backend's own working-activity line, when it folds one itself (the
   * Claude backend does; a DSH session publishes through the
   * `dsh-working-activity` plugin's session projection instead and serves
   * no capability here). One `WorkingActivityView` per phase or line change
   * while the session works; a late subscriber gets the latest value once on
   * subscribe. Absent (or silent) → the UI keeps its classic spinner.
   */
  readonly workingActivity?: { subscribe(listener: (view: WorkingActivityView) => void): () => void }
  /** Backend-specific `/doctor` lines (version drift, executable, …), already
   *  localized by the backend. */
  readonly diagnostics?: { lines(): readonly string[] }
  /** Backend escape hatches; read only from the owning backend's directory. */
  readonly native: { readonly dsh?: DshNative; readonly claude?: ClaudeNative; readonly acp?: AcpNative }
}

/**
 * One page of a subagent's own transcript, read from the backend's durable
 * store (design agent-team-panels §2). The events are the child-lane leaf
 * events (assistant.message / tool.call / tool.result, oldest first) in
 * the same vocabulary live lane traffic uses; parentAgentId is the
 * parent_agent_id of the child's messages — null = a depth-1 child
 * (spawned by the main loop) or old-format metadata that never recorded it.
 */
export interface SubagentTranscriptPage {
  readonly events: readonly AgentEvent[]
  readonly parentAgentId: string | null
  /** The SessionMessage uuids the events cover (dedup keys: the live tail
   *  and an overlapping reload drop what these already account for). */
  readonly uuids: readonly string[]
  /** Older messages exist on disk before this page's first message. */
  readonly hasOlder: boolean
  /** Messages the disk transcript holds before this page's first message
   *  (the next older window asks for skipFromStart - count). */
  readonly skippedFromStart: number
}

/** An older slice request: `count` messages ending just before
 *  `skipFromStart` (the pagination bookkeeping of the page already shown). */
export interface SubagentTranscriptWindow {
  readonly count: number
  readonly skipFromStart: number
}
