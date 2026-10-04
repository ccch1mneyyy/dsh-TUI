/**
 * Typed optional session capabilities (docs/agent-backend-design.md).
 * Every member is optional: absence means the backend does not support it,
 * and the channel says so explicitly instead of a silent no-op.
 *
 * `native` is the escape hatch for specialists that are not
 * capability-shaped yet. The marker interfaces below carry no vendor types;
 * each backend augments its own marker from inside its directory, and only
 * that directory may read it (enforced by `verify:boundary`).
 */
import type { WorkingActivityView } from '../adapter/ports/channel-view.js'
import type { AgentEvent, CommandInfo, PermissionRequestView } from './events.js'
import type { AgentSessionRef } from './refs.js'

/** DSH escape hatch; augmented by `src/dsh-adapter/backend/session.ts`. */
export interface DshNative {
  readonly kind: 'dsh'
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

/** Read-only mapping and connection details for a backend channel. */
export interface ChannelProfileView {
  readonly id: string
  readonly name: string
  /** Exact requested-id → actual model, in file order. */
  readonly models: readonly { readonly from: string; readonly to: string }[]
  /** Tier keyword → actual model, in file order (`default` = any-model rule). */
  readonly tiers: readonly { readonly tier: string; readonly to: string }[]
  /** The connection: endpoint, whether a token is stored, and the
   *  channel-private env keys (never a token literal); absent on
   *  mapping-only channels. `fingerprint` names the whole connection
   *  (endpoint + token + env) without exposing any secret: equal
   *  fingerprints are the same connection, so switching between them needs
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

/** Every optional capability of one live session. */
export interface SessionCapabilities {
  readonly pendingRetraction?: { remove(clientMessageId: string): boolean }
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
    /** The model name that serves the session when the live id is an alias.
     *  Presenters use it for display; data surfaces keep the requested id. */
    display?(): string | undefined
  }
  readonly effort?: {
    /** Set when `levels()` serves the CLI-standard tiers (low → max)
     *  because the current model row declares no levels of its own (a
     *  relay channel's custom row). The CLI accepts any effortLevel flag
     *  anyway, so the standard ladder is offered and flagged here so the
     *  picker can say so. Undefined = the list is the model's own (or there
     *  is no list). */
    readonly levelsFallback?: true
    levels(): readonly EffortOption[]
    current(): string | undefined
    set(id: string | null): Promise<void>
  }
  readonly modes?: {
    list(): readonly ModeOption[]
    /**
     * The modes the Shift+Tab cycle may walk. Absent = the cycle walks
     * `list()` unchanged. A backend may declare a narrower cycle: a mode
     * that should only be entered by an explicit pick (Claude's
     * `bypassPermissions` in the /permission picker) stays out of it, so a
     * reflexive keypress never lands there. The narrowing is declared here
     * so the UI never hardcodes mode names to shape the cycle.
     */
    cycle?(): readonly ModeOption[]
    current(): string
    set(id: string): Promise<void>
  }
  /**
   * The backend's relay channel profiles (the Claude backend's channels.json):
   * the /channel picker's roster, the active pick (whose mapping the model
   * display resolves through), and the settings import. Synchronous: the
   * store is a small best-effort file, like prefs.ts.
   */
  readonly channels?: {
    list(): readonly ChannelProfileView[]
    /** The active channel's id; undefined when none is active. */
    activeId(): string | undefined
    /** Switch the active channel (persists; a no-op for an unknown id). */
    setActive(id: string): void
    /** Import/refresh the channel profile implied by the CLI settings env;
     *  undefined when the env holds nothing importable. The connection
     *  (base URL + auth token) is imported too: the token moves into the
     *  credential store and the profile keeps only its ref. */
    importFromSettings(): ChannelProfileView | undefined
    /** Upsert one profile with connection fields (the /channel wizard): a
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
    /** What the CLI settings env holds for an import (the wizard's offer): the
     *  base URL and the absorbable tier rules, without creating anything. */
    peekSettingsImport?(): { readonly baseUrl?: string; readonly tiers: Readonly<Record<string, string>> } | undefined
  }
  readonly compact?: { run(): Promise<void> }
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
     *  (Claude: getSubagentMessages through the replay translator into
     *  AgentEvents). Absent = the backend has no transcript data source;
     *  rejects when the read fails. */
    history?(agentId: string, window?: SubagentTranscriptWindow): Promise<SubagentTranscriptPage>
    /** How subagent messages reach this session. */
    messaging?: 'parent-mediated'
  }
  /**
   * Background tasks: `stop` asks the backend to stop one; `readOutput`
   * reads the tail of its output (bounded by the backend; rejects when the
   * task has no readable output).
   */
  readonly tasks?: { stop(taskId: string): Promise<boolean>; readOutput?(taskId: string): Promise<string> }
  /**
   * The durable record behind "load earlier": read-only, synchronous and
   * bounded (a user click waits for it). `record()` replays everything the
   * backend persisted for the bound session; folded rows are restored from
   * it, matched by their stable anchors (user / assistant `anchor`, tool
   * `callId`). Undefined when it cannot be read now. `older()` returns the
   * next slice older than what `history()` replayed (history a compaction
   * cut off), oldest first, and advances past it; the slice is empty when
   * nothing older remains. `hasOlder()` says whether one may still exist.
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
  /** DSH specialists not yet covered by a typed capability. */
  readonly native: { readonly dsh?: DshNative }
}

/**
 * One page of a subagent's own transcript, read from the backend's durable
 * store. The events are the child-lane leaf events (assistant.message /
 * tool.call / tool.result, oldest first) in the same vocabulary live lane
 * traffic uses; parentAgentId is the parent_agent_id of the child's
 * messages: null = a depth-1 child (spawned by the main loop) or old-format
 * metadata that never recorded it.
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
