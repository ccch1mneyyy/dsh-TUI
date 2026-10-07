/** Host-owned in-process Channel contract. No runtime or upstream imports. */
import type { ChatRow, AgentStatus, TokenUsage, TurnUsageSummary, SessionCostByModel, SubagentCostEntry, NotificationItem, ChannelGoal, TodoPanelItem, LoadedContext, PendingMessage, ChannelSceneMetadata, SubagentState, SubagentControl, BackgroundJobState, JobControl, StagedImageInput, StagedImageHandle, ComposerImageRef, ComposerSubmission, ExternalCommandOutcome, TranscriptImage, ResumeResult, EffortOption, PermissionPresetSnapshot, PresetOption, LlmModelInfo, LlmProviderInfo, SkillInfo, CredentialStatus, AgentViewRow, AgentViewDispatchResult, BackgroundResult, RawTrajEvent, TrajectoryLane, TrajectorySource, ChannelSelection, AttachedContext, CompactionStatus, ContextOccupancy, ContextBreakdown, ChannelCapabilities, ChannelCostReport, ChannelRateLimit, ChannelSessionRef, BackendModeOption, BackendChannelOption, BackendChannelInput } from './channel-view.js'
import type { SpinnerMode, ToolBackground, ScrollGutterMode, PageMarginSetting, StatusBarConfig, SessionModeSpec, SplashFontSetting, JobGroupFoldMode, BrandSetting } from './channel-display.js'
import type { LocalCommand, CommandCompletion, BalanceResult, FileCandidate, RecapOutcome } from './channel-catalog.js'
import type { AgentCapabilities } from './channel-capabilities.js'
import type { TuiRewindMode, SessionTreeData, SessionSummary, PreviewEntry, ForeignSource, ForeignSessionRow, ForeignImportOutcome } from './channel-session.js'
import type { TuiWorkspaceTarget, TuiWorkspaceCommand, TuiWorkspaceCommandResult, TuiWorkspaceEntry } from './channel-workspace.js'
import type { ProviderSetupHost, OAuthProviderStatus, OAuthSetupHost, SettingsHost, TuiSettingsSection } from './channel-settings.js'

/** One backend session's sign-in surface (`ChannelUi.backendAuth`). */
export interface BackendAuthHost {
  /** Report status, present OAuth, then reconnect after sign-in or sign-out. */
  login(present: (oauth: OAuthSetupHost, provider: string) => Promise<'added' | 'updated' | 'deleted' | 'signed-out' | 'cancelled' | 'failed'>): Promise<void>
  /** Remove only this backend's host OAuth credential, never its native login. */
  logout?(): Promise<boolean>
}

/** Relay profile management for the bound backend session. */
export interface BackendChannelsHost {
  snapshot(): { readonly channels: readonly BackendChannelOption[]; readonly activeId: string | undefined }
  activate(id: string): { readonly ok: boolean; readonly restart: boolean }
  importFromSettings(): { readonly option: BackendChannelOption; readonly restart: boolean } | undefined
  save(input: BackendChannelInput): BackendChannelOption | undefined
  remove(id: string): boolean
  peekImport(): { readonly baseUrl?: string; readonly tiers: Readonly<Record<string, string>> } | undefined
}
export interface BackendModesHost { snapshot(): { modes: readonly BackendModeOption[]; currentIndex: number }; set(id: string): Promise<boolean> }
export interface BackendMcpHost { reconnect(name: string): Promise<boolean>; toggle(name: string, enabled: boolean): Promise<boolean> }
/** The bound session's typed `goals` capability (`/goal` on a non-DSH
 *  session): each call resolves true once the backend took the change
 *  (the goal itself arrives as `goal.change`), false after a reported
 *  failure. */
export interface BackendGoalsHost {
  set(objective: string, options?: { readonly tokenBudget?: number }): Promise<boolean>
  pause(): Promise<boolean>
  resume(): Promise<boolean>
  clear(): Promise<boolean>
}

/**
 * The public channel surface a screen renders: the full transcript and live
 * status snapshot (tokens, spinner, working activity, goals, todos, loaded
 * context) plus every action the TUI can take (submit, steer, cancel,
 * rewind, resume, model switching, …). Implementations mutate internal state
 * and bump `version` so subscribed screens re-render.
 */
export interface ChannelUi {
  /** Monotonic version — bump on every mutation so screens can re-render. */
  readonly version: number
  readonly rows: readonly ChatRow[]
  /** Live editor selection from the IDE channel (undefined = no IDE / no
   *  selection / link dropped). Protocol-2 pushes carry the editor buffer's
   *  own text; the submit path attaches it verbatim and only falls back to
   *  reading the file from disk for protocol-1 pushes. */
  readonly selection: ChannelSelection | undefined
  readonly status: AgentStatus | 'starting' | 'disposed'
  readonly sessionTitle: string
  /** Per-session accent color name (`/color`), '' when unset — persisted via
   *  a `session/color` log event so it survives resume/rewind. Renders as
   *  the prompt-input border + session label chip accent (cc/sessionColors). */
  readonly sessionColor: string
  readonly agentId: string
  /** Identity of the session behind the bound agent. Read by session-scoped
   *  consumers — the activity projection is keyed by session, and the two ids
   *  are only conventionally equal (both are minted as a `SessionId`), so the
   *  session must be nameable on its own rather than inferred from the agent. */
  readonly sessionId: string
  /** TUI-owned generation that changes on every live Agent rebind. */
  readonly agentBindingGeneration: number
  /** Cross-backend identity of the bound session (`backendId` + the
   *  backend's own session id); follows every rebind. */
  readonly sessionRef: ChannelSessionRef
  /** What the bound backend session supports, as plain data: the UI hides
   *  commands and affordances whose capability is absent instead of letting
   *  them fail. A DSH session supports everything the TUI offers. Distinct
   *  from {@link ChannelUi.capabilities}, which describes what the current
   *  DSH agent's composition mounts (compaction, `/plan`, skills, …). */
  readonly backendCapabilities: ChannelCapabilities
  /** The session cost the backend itself reported (Claude
   *  `total_cost_usd`), or undefined when the backend reports none; the
   *  status line then falls back to its local estimate. */
  readonly costReport: ChannelCostReport | undefined
  /** Subscription usage windows the backend reported (Claude
   *  `rate_limit_event`), or undefined when it reports none. */
  readonly rateLimit: ChannelRateLimit | undefined
  /** The bound session has durable history older than the painted
   *  transcript (a compaction cut it off before a resume): "load earlier"
   *  shows even when no row is folded, and `loadOlder()` prepends it. */
  readonly olderHistory: boolean
  /** `dsh-tui.recapOnOpen` (default on): auto-summarize the session tail
   *  into the dim AutoRecapRow when the session opens/resumes. Read live
   *  (settings service), so a `/settings` change applies on the next
   *  session switch; absent settings service → on. */
  readonly autoRecapOnOpen: boolean
  /** Settings namespace this mount registered under — the Config owner's
   *  Loader id (see `resolveSettingsNamespace`), not a fixed plugin name, so
   *  custom mount ids are supported. Read sites that look the TUI's section up
   *  through `describe()`/`listNamespaces()` must match on this value; a
   *  literal `'dsh-tui'` silently misses every non-default mount. */
  readonly settingsNamespace: string
  /** Resolved model id (from the plugin config). */
  readonly model: string
  /** Display name of the live model when a channel mapping says the id the
   *  runtime echoes is not what actually serves the request (relay channels
   *  echo the requested id back; backends/claude/modelEnv.ts resolves it
   *  from the user ANTHROPIC_*_MODEL env plus the local model-names.json).
   *  UI renders this instead of `model` when present; attribution and
   *  matching keep using `model`. */
  readonly modelDisplay: string | undefined
  /** Provider route of the live agent. */
  readonly provider: string
  /** Raw cordis.yml `provider` key (undefined when unset) — the boot-time
   *  pin `/reload` must never override. */
  readonly configuredProvider: string | undefined
  /** Raw cordis.yml `model` key (undefined when unset). */
  readonly configuredModel: string | undefined
  /** Explicit cordis.yml `preset` (undefined = roster default wins) — `/reload`
   *  must not override a static deployment choice. */
  readonly configuredPreset: string | undefined
  /** Explicit cordis.yml `activityFrames` (undefined = pref/default wins). */
  readonly configuredActivityFrames: string | undefined
  /** Explicit cordis.yml `lang` (undefined = settings/lang.json wins). */
  readonly configuredLang: string | undefined
  /** Running token totals across the session's assistant messages. */
  readonly tokens: TokenUsage
  /** 本会话主会话用量按模型分桶（费用估算输入）。与 `tokens` 并行累计，
   *  既有 `tokens` 语义与显示不变；会话中途换模型时历史用量留在原模型桶。 */
  readonly mainCost: SessionCostByModel
  /** 子代理 durable 用量按 (provider, model) 分桶快照（费用估算输入）。 */
  readonly subagentCost: readonly SubagentCostEntry[]
  /** Working directory of the session. */
  readonly cwd: string
  /** Human-facing cwd (remote POSIX path/URI instead of a host alias). */
  readonly displayCwd: string
  /** Current git branch, when the cwd is inside a git worktree. */
  readonly gitBranch: string | undefined
  /** True between turn/start and turn/end — drives the working spinner. */
  readonly working: boolean
  /** In-flight compaction of this session's history, or undefined when none
   *  is running (see {@link CompactionStatus}). Required-and-undefined rather
   *  than optional: the effect inventory maps over `keyof ChannelUi`, and an
   *  optional member widens that key union with `undefined`, which breaks the
   *  `Record` constraint on the inventory itself. */
  readonly compaction: CompactionStatus | undefined
  /** True while a user-requested abort (Ctrl+C/Esc interrupt) has not yet
   *  converged — no turn/start or turn/end has retired the aborted turn.
   *  Chat uses it so a repeated Ctrl+C during a stuck abort force-exits. */
  readonly cancelPending: boolean
  /** Which phase the spinner should present while working. */
  readonly spinnerMode: SpinnerMode
  /** Chars streamed as text this turn (feeds the spinner token counter). */
  readonly responseChars: number
  /** Number of tool calls still in flight this turn. */
  readonly activeToolCount: number
  /** Wall-clock ms of turn/start (spinner elapsed timer). */
  readonly turnStart: number
  /** Last user prompt text (sticky header + statusline). */
  readonly lastUserText: string
  /** Transient notifications, newest last. */
  readonly notifications: readonly NotificationItem[]
  /** Adapter-advertised context capacity for the model route, when known. */
  readonly contextWindow: number | undefined
  /** Reasoning effort of the latest request header, when the adapter sets one. */
  readonly reasoningEffort: string | undefined
  /** The live route's reasoning-effort level ids, low → high (the last entry
   *  is the top tier). Consumed by top-tier-triggered UI (effort ignition). */
  readonly effortLevels: readonly string[] | undefined
  /** Usage of the most recent request (context share + cache hits come from
   *  this, not the running totals — each request's input IS the context).
   *  `at` is the producing message's event time, so readouts that quote
   *  this request can say when it was measured. */
  readonly lastUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number; at: number }
    | undefined
  /** Ledger of the most recently ended turn: per-turn usage aggregate,
   *  retry count, span, model/effort. Kept until the next turn ends, so the
   *  footer's turn mini-summary can read it while the next turn runs without
   *  mixing the two. Undefined before any turn ended. */
  readonly turnUsage: TurnUsageSummary | undefined
  /**
   * Context occupancy — the ONE source of truth for the footer's `ctx` field,
   * the segmented context bar, the working-activity line's `⚠ ctx N%` prefix,
   * `/tokens` + `/status`, and the context-low warning. Read from DSH's own
   * `contextPressure` session projection (`projectedTokens ?? pressureTokens`,
   * the same number the Web UI shows) and refreshed by that projection's change
   * feed — never by a per-render fold.
   *
   * `undefined` only before anything is known: no request yet AND no meter (a
   * bare `cordis.yml` composition). {@link ContextOccupancy.source} says which
   * path answered; see `dsh-adapter/context-occupancy.ts` for the deliberate
   * divergence from the official "render nothing" behavior.
   *
   * Required-and-undefined rather than optional, matching `compaction`: the
   * effect inventory in `adapter/channel/ui-policy.ts` maps over
   * `keyof ChannelUi`, and an optional member would widen that union.
   */
  readonly contextOccupancy: ContextOccupancy | undefined
  /**
   * What the occupancy total is made of, from the same meter unit's
   * `contextBreakdown` projection (system prompt / request-envelope tool schemas
   * / everything else). The segmented bar joins it with {@link contextSegments}
   * to weight its five fills; `undefined` when the mounted meter does not publish
   * a composition, in which case the bar uses those estimates alone.
   *
   * Never a total: only {@link contextOccupancy} numerator answers how full the
   * window is (see the type's own doc).
   */
  readonly contextBreakdown: ContextBreakdown | undefined
  /** Output tokens per second of the current/last turn's response, when known. */
  readonly tps: number | undefined
  /** Per-turn tps samples (sparkline history), oldest first. */
  readonly tpsSamples: readonly { tps: number; at: number }[]
  /** Working-activity indicator preset name (`claude`/`moon`/…/`random`). */
  readonly activityFrames: string | undefined
  /** Edit/Write diff presentation preference (`auto`/`split`/`unified`). */
  readonly diffLayout: 'auto' | 'split' | 'unified'
  /** Thinking-block display (`preview` = 2-3 line live stream + fold per
   *  step; `full` = expanded until turn end). */
  readonly thinkingFold: 'preview' | 'full'
  /** Grouping/folding of runs of consecutive background-job cards (settings
   *  `dsh-tui.jobGroupFold`): `auto` folds a settled run of 3+ into its
   *  summary line, `always` folds any run of 2+, `never` never folds on its
   *  own (a header click still folds a single run). */
  readonly jobGroupFold: JobGroupFoldMode
  /** Live tool-card background treatment. */
  readonly toolBackground: ToolBackground
  /** What the fullscreen transcript's right gutter shows (settings
   *  `dsh-tui.scrollGutter`: turn timeline / proportional scrollbar /
   *  nothing). */
  readonly scrollGutter: ScrollGutterMode
  /** Root page inset (settings `dsh-tui.pageMargin`): a preset name
   *  (`none` / `slim` / `normal` (default) / `roomy`) or a custom `NxM`
   *  spec (columns per side × rows top/bottom) inset the whole UI from the
   *  terminal edges — terminals without their own viewport padding (bare
   *  WSL, tmux, SSH) otherwise hug the screen border. */
  readonly pageMargin: PageMarginSetting
  /** Terminal-card header folding (settings `dsh-tui.foldTerminalCommand`):
   *  collapse a multi-line command title to its first line + count hint. */
  readonly foldTerminalCommand: boolean
  /** Turn-usage ledger row in the transcript (settings `dsh-tui.turnUsageRow`;
   *  off by default): the quiet right-aligned line that closes each turn.
   *  Display only: the ledger itself is always collected for `turnUsage`,
   *  /tokens, /status and the footer hover. */
  readonly turnUsageRow: boolean
  /** Whether the session-name chip shows on the prompt top border's right
   *  side (settings `dsh-tui.promptSessionLabel`; off by default). */
  readonly promptSessionLabel: boolean
  /** Whether the fullscreen draft editor is enabled (settings
   *  `dsh-tui.expandEditor`; on by default) — gates the ⛶ affordance and
   *  the expandEditor shortcut. */
  readonly expandEditor: boolean
  /** Smooth streaming reveal (settings `dsh-tui.smoothStreaming`; on by
   *  default): live-arriving assistant text, expanded thinking, and tool
   *  call bodies paint through a ~30fps reveal instead of jumping per
   *  provider burst. */
  readonly smoothStreaming: boolean
  /** Live status-footer visibility and compactness preferences. */
  readonly statusBar: Readonly<StatusBarConfig>
  /** Whether the header's pixel whale art shows (settings `dsh-tui.whale`). */
  readonly whale: boolean
  /** Idle whale behaviors switch (settings `dsh-tui.whaleIdle`). */
  readonly whaleIdle: boolean
  /** Swap the header's pixel whale for the static maid portrait (settings
   * `dsh-tui.whaleGirl`; off by default). */
  readonly whaleGirl: boolean
  /** Apply an idle-whale-behavior change (see the public Channel type). */
  setWhaleIdle(enabled: boolean): void
  /** Big-text face on the header splash (settings `dsh-tui.splashFont`):
   *  `daily` (the default) rotates by local date, any other id pins that one
   *  face — see `components/splashFonts.ts` for the registry. */
  readonly splashFont: SplashFontSetting
  /** Brand look (settings `dsh-tui.brand`): `auto` (the default) follows the
   *  active backend — Claude boots orange (`CLAUDE`/`CODE` title, Claude girl,
   *  ember theme); the other values pin one look. See `branding.ts`. */
  readonly brand: BrandSetting
  /** Apply a brand-look change (see the public Channel type). */
  setBrand(setting: BrandSetting): void
  /** Apply a maid-portrait change (see the public Channel type). */
  setWhaleGirl(enabled: boolean): void
  /** Minimal UI (settings key `dsh-tui.minimal`, labeled 极简界面 /
   *  "Minimal UI"): no header splash, no emoji glyphs, no decorative colors;
   *  code highlight and tool colors stay. This is the INTERFACE switch and
   *  has nothing to do with the kernel's agent preset `minimal` (极简模式 /
   *  "Minimal"), which changes the model-facing tool catalog. */
  readonly minimalUi: boolean
  /** @deprecated Pre-rename alias of {@link minimalUi}; reads the same flag.
   *  Kept because plugin scenes receive this port through
   *  `TuiSceneProps.channel` (a published surface). Use `minimalUi`.
   *
   *  REMOVAL: v0.13 — the rename and deprecated aliases first ship in
   *  v0.12.0, leaving one released minor-version deprecation window as
   *  `docs/plugins.md` promises for a frozen seam. Delete `minimal` (and
   *  `setMinimal()` below, plus the `'setMinimal': 'mutate'` row in
   *  `adapter/channel/ui-policy.ts`) in v0.13, gated on one concrete audit:
   *  scan the scene-plugin consumption surface — this repo's `src/**`
   *  re-exports and every plugin reached through `TuiSceneProps.channel`
   *  on the dsh-tui-ecosystem org — for a read of `.minimal` or a call to
   *  `.setMinimal(`. Zero consumer hits → delete in v0.13; a hit found at
   *  that cut is migrated in the same release instead of pushing the
   *  removal out again. */
  readonly minimal: boolean
  /** Whether the working-activity line is shown (config.activity); the line
   * itself is read from the plugin's session projection, not this port. */
  readonly activityEnabled: boolean
  /** Whether the segmented context bar row shows in the status footer
   *  (config.contextBar; the status/mode lines are unaffected). */
  readonly contextBarEnabled: boolean
  /**
   * Current same-session goal projection, when a goal exists. Derived live
   * from the durable goal events in the session log — top-level
   * `goal/change` snapshots (every goal mutation appends one) plus the
   * goal-sourced continuation rounds that advance the counter — so this
   * snapshot tracks create/edit/pause/resume/complete/block/clear in real
   * time and replays correctly on resume/rewind.
   */
  readonly goal: ChannelGoal | undefined
  /**
   * Latest todo-list snapshot (`todo/write` whole-list event, last write
   * wins). Log-only UI state, updated live and on replay.
   */
  readonly todos: readonly TodoPanelItem[]
  /**
   * Snapshot of the context a fresh conversation for this agent will load
   * (system prompt sections, dynamic context, workspace instructions, skill
   * catalog, tools), computed at boot and on every agent swap. `undefined`
   * while loading or when the snapshot could not be assembled — the startup
   * panel stays hidden until it lands.
   */
  readonly loadedContext: LoadedContext | undefined
  /**
   * Messages submitted while the model was working and not yet claimed by a
   * turn (`steer` → next step boundary of the running turn, `followup` →
   * after the turn ends). Driven by agent inbox events.
   */
  readonly pending: readonly PendingMessage[]
  /**
   * Effective slash commands: built-in locals plus plugin-registered
   * commands (plan/goal/…) merged from the DSH command registry. The
   * registry is the source of truth for external names — a plugin shadows
   * nothing here; locals win on name collisions.
   */
  readonly commandList: readonly LocalCommand[]
  /** Context-aware slash completions, including plugin subcommands. */
  commandCompletions(input: string): readonly CommandCompletion[]
  /**
   * What the CURRENT agent's composition actually serves (compaction, pruning,
   * questionnaire, skills, and the route `/compact` and `/plan` take), with
   * the evidence for each fact documented in
   * `dsh-adapter/channel/capabilities.ts`.
   *
   * Resolved from live services through the agent's own preset scope chain —
   * never from a preset-id table — so a user preset that adds a service back
   * gets the full feature set with no consumer change. Consumers use it to
   * refuse-with-reason instead of failing on use, and to mark an entry whose
   * capability is missing in Help and `/` completion.
   */
  capabilities(): AgentCapabilities
  /**
   * Run a plugin-registered slash command against the live agent (DSH
   * `dsh-commands` registry): logs `command/run`/`command/done` and returns
   * the handler's result text — `''` when the handler succeeded silently,
   * `undefined` when the registry has no such command (the caller falls
   * back to sending the line to the model).
   */
  runExternalCommand(name: string, rawInput: string, images?: readonly ComposerImageRef[]): Promise<string | undefined>
  /** Detailed companion used by draft-owning composers. `undefined` means
   * the registry no longer has the command, so the draft stays untouched. */
  runExternalCommandOutcome(
    name: string,
    rawInput: string,
    images?: readonly ComposerImageRef[],
  ): Promise<ExternalCommandOutcome | undefined>
  /**
   * Plugin-registered full-screen scene currently replacing the conversation
   * (the `dsh-tui-scenes` runtime), if any. The chat screen renders its
   * component INSTEAD of the transcript — the same whole-terminal treatment
   * the trajectory scene gets — and hands it the keyboard; `undefined`
   * renders the conversation normally.
   */
  readonly pluginScene: ChannelSceneMetadata | undefined
  /**
   * Open a registered plugin scene by id. Plugin command handlers usually
   * call the runtime directly (`ctx.tuiScenes.open`); this passthrough lets
   * host-side UI code do the same without touching cordis services.
   */
  openPluginScene(id: string): boolean
  /** Close the open plugin scene, if any (a no-op otherwise). */
  closePluginScene(): void
  /** 侧问：无工具单轮 LLM 调用，复用当前会话上下文；结果不落 session log。 */
  sideQuestion(
    question: string,
    options?: { signal?: AbortSignal; onText?: (delta: string) => void },
  ): Promise<{ answer: string | null; error?: string }>
  /**
   * This app's estimate of the context by content type — the weights behind the
   * segmented bar's five fills (see {@link contextBreakdown} for the meter's own
   * composition, which takes precedence where it exists). Never a total: the
   * bar's length and readout come from {@link contextOccupancy}, and
   * `barSegments` only uses these numbers to weight that authoritative span
   * (its message side, or the whole composition when no meter value exists).
   */
  readonly contextSegments: {
    system: number
    prompt: number
    assistant: number
    thinking: number
    tools: number
  }
  /** Active subagents spawned by the current session. */
  readonly subagents: readonly SubagentState[]
  /** Native control operations; unavailable providers safely return false. */
  readonly subagentControl: SubagentControl
  /**
   * Background jobs of the current session (`run_in_background` tool work),
   * live-tracked from the harness job registry. Empty when the composition
   * has no jobs service. Drives the `/jobs` panel, transcript job cards and
   * the status-line chip.
   */
  readonly backgroundJobs: readonly BackgroundJobState[]
  /** Cancellation of a background job with the owning agent's authority. */
  readonly jobControl: JobControl
  subscribe: (listener: () => void) => () => void
  /** Current composer generation. Async paste continuations capture this
   *  before I/O and must not mutate a different session's draft. */
  stagedImageGeneration(): number
  /** Validate and persist a pasted image, returning its prompt placeholder. */
  stageImage(input: StagedImageInput): Promise<string>
  /** Draft-safe composer companion: bind persistence to one session epoch
   * and return an opaque capability whose visible label belongs to Prompt. */
  stageComposerImage(input: StagedImageInput, generation: number): Promise<StagedImageHandle>
  /** Whether a capability is still live in the current composer session. */
  hasStagedImage(stageId: string): boolean
  /** Revoke a capability that was staged for a draft which no longer exists.
   * Durable attachment storage remains content-addressed; this only releases
   * the editable-composer lookup and its preview facade. */
  discardStagedImage(stageId: string): void
  /** The staged image behind one opaque capability, as the same lazily-read
   *  facade transcript rows use; undefined once evicted or cleared. */
  stagedImage(stageId: string): TranscriptImage | undefined
  /** The profile's image-paste limits, for callers that must bound work
   *  BEFORE reading bytes (a Finder path is untrusted input). Undefined
   *  when the composition has no attachment service. */
  stagedImageLimits(): {
    readonly maxImageBytes: number
    readonly maxImagesPerMessage: number
    readonly maxImageDimension: number
    readonly maxImagePixels: number
  } | undefined
  /**
   * Contexts a side panel staged for the NEXT submission ("Send to Chat",
   * side-panel design §6.7), oldest first. The composer renders one chip per
   * entry above the input row; the submission that captures them consumes and
   * clears the list, and every session-scoped reset (resume / rewind / new /
   * model switch) empties it with the other session projections.
   */
  readonly attachedContexts: readonly AttachedContext[]
  /**
   * Stage one panel context on the composer. The body is capped at the shared
   * `MENTION_MAX_FILE_CHARS` limit when it is staged (`truncated` records the
   * cut), and a duplicate `sourceId` + `title` REPLACES the existing entry
   * instead of stacking a second chip.
   */
  attachContext(input: { source: 'panel'; sourceId: string; title: string; content: string }): void
  /** Drop one staged context by its `id` (an unknown id is a no-op). */
  detachContext(id: string): void

  submit(text: string, images?: readonly ComposerImageRef[]): void
  /**
   * Steer a message into the running turn (Codex/pi semantics): injected at
   * the next step boundary, the agent continues without aborting.
   */
  steer(text: string, images?: readonly ComposerImageRef[]): void
  /** Pull a pending message back out of the inbox (Alt+Up) for re-editing. */
  removePending(id: string): boolean
  /** Abort the in-flight turn (`Ctrl+C` while working). While `cancelPending`
   *  stays true the abort has not converged; Chat force-exits on the next
   *  Ctrl+C press in that window. */
  cancel(): void
  /** Abort the in-flight turn and process `texts` right away (Ctrl+Enter
   *  with queued input): each text is re-queued as a followup once the abort
   *  settles, so the new turn starts immediately. Returns the count queued. */
  interruptAndDeliver(inputs: readonly (string | ComposerSubmission)[]): number
  /** Esc with queued input: abort the turn and park the queued previews as a
   *  dock, as Claude Code does. The backend drops its queued copies with the
   *  aborted turn, and nothing re-delivers them until the user sends the
   *  dock (⏎ / `deliverDocked`) or retracts items (Alt+↑ / the ↑ editor).
   *  Returns the count docked; 0 means nothing new was parked (the caller
   *  may still `cancel`). */
  interruptAndDock(): number
  /** Deliver every docked queued message now (⏎ on an empty draft), FIFO,
   *  exactly once. Rows still awaiting their interrupt receipt's verdict
   *  stay parked, since their backend copies may yet run, and the call
   *  notifies how many were held. Returns the count sent. */
  deliverDocked(): number
  /**
   * Lossless swap: retract the docked row `id` into the composer and park
   * the live draft (text + staged images) at the pending tail as a new
   * docked row, in one queue write. Nothing sends and no undo history is
   * lost. The backend never saw the parked draft, so it stays outside the
   * interrupt-receipt fence: a settling receipt must not un-dock it.
   * Returns false when `id` is no longer a docked row (claimed, discarded or
   * un-docked meanwhile), or while an unsettled interrupt receipt still
   * holds the row.
   */
  swapDockedForDraft(id: string, draft: { text: string; images?: readonly ComposerImageRef[] }): boolean
  /** Rewind the conversation to a past user message (the double-Esc rewind):
   *  forks the session through that message, swaps in a fresh agent, and
   *  returns the message text for re-editing — or `null` when unwritable.
   *  `mode` is the plugin-offered rewind mode the user picked (the
   *  tui/rewind-prompt seam), null for the plain conversation rewind. */
  rewindTo(row: ChatRow, mode?: string | null): Promise<string | null>
  /**
   * The rewind decision prompt (tui/rewind-prompt event): asked when the
   * picker confirms a message, before the confirm pane renders. 'cancel'
   * vetoes the rewind (reason already toasted), `{ modes }` adds plugin
   * choices to the confirm pane, null means no opinion (plain confirm).
   */
  promptRewind(row: ChatRow): Promise<{ modes: readonly TuiRewindMode[] } | 'cancel' | null>
  /**
   * The session family tree for the /tree screen (pi's Session Tree): the
   * live session's whole lineage — ancestors, siblings, descendants —
   * stitched across fork sessions into one message-level tree. `null` (with
   * a notify) when session persistence is unavailable or the live session
   * swapped while the family loaded.
   */
  buildSessionTree(): Promise<SessionTreeData | null>
  /**
   * Session-tree fork: `rewind` drops the picked user turn (its prompt comes
   * back as the returned text), `fork` keeps the picked entry. `seq` is the
   * tree entry's source event seq inside `sessionId`'s log; `sessionId` may
   * be any family member (adopting a dead branch forks IT at the picked
   * point). Null = refused (the channel notified why).
   */
  rewindToNode(sessionId: string, seq: number, mode?: 'rewind' | 'fork'): Promise<string | null>
  /** `/fork`: fork the current session at its tip into a persisted copy the
   *  user enters via `/resume` — the live session keeps running untouched. */
  forkSession(): Promise<boolean>
  /** Switch the live agent to a persisted session, replaying its history. */
  resumeTo(sessionId: string): Promise<ResumeResult>
  /** Start a fresh conversation (`/new`): a brand-new agent + session, the
   *  transcript cleared, the resume marker forgotten. */
  newSession(): Promise<boolean>
  /** Workspace targets contributed by the TUI and optional providers. */
  listWorkspaces(): Promise<readonly TuiWorkspaceTarget[]>
  /**
   * The durable workspace registry, in its own order.
   *
   * The workspace home screen's sidebar is built from this (not from
   * `listWorkspaces`): it is the ledger the user actually registers into, so
   * an entry exists for every workspace — including ones whose sessions are
   * all gone, whose directory has been deleted, or that never had a session.
   */
  listWorkspaceRegistry(): Promise<readonly TuiWorkspaceEntry[]>
  /** Drop a workspace registration; the directory and its session logs stay. */
  removeWorkspace(path: string): Promise<boolean>
  /** Rename the durable workspace owning `path` (title only; the path is immutable). */
  renameWorkspaceAt(path: string, title: string): Promise<boolean>
  /** Resolve an absolute path, file URL, or provider URI. */
  resolveWorkspace(reference: string): Promise<TuiWorkspaceTarget | undefined>
  /** Start a fresh session in the selected workspace. */
  switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean>
  /** Rename the current durable workspace. */
  renameWorkspace(title: string): Promise<boolean>
  /** Provider-owned workspace subcommands. */
  workspaceCommands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[]
  runWorkspaceCommand(name: string, input: string): Promise<TuiWorkspaceCommandResult | undefined>
  /** Switch the live model (`/model` picker): forks the conversation at its
   *  current end and continues it with a new agent routed to `provider`/`model`.
   *  The history replays unchanged; only the request route changes. */
  switchModel(provider: string, model: string): Promise<boolean>
  /** The live route's effort levels + adapter default for the `/effort`
   *  slider; empty `efforts` after notifying when unsupported/unavailable.
   *  `levelsFallback` is true when the ladder is the CLI-standard
   *  compatibility offer (the model row declares no tiers of its own) —
   *  the slider marks it as such instead of implying the model's list. */
  listEfforts(): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined; levelsFallback?: true }>
  /** Set one effort level by id (validated against the adapter list);
   *  false + a notify when the id is not offered. Persists like the old
   *  Shift+Tab cycle (~/.dsh-tui/effort.json). */
  setEffort(id: string): Promise<boolean>
  /** Re-seat the future-sessions default reasoning effort (cordis.yml
   *  `effort` → persisted /effort choice → adapter default). The live agent
   *  is re-pinned too when its route offers the level, so a change lands on
   *  its next request. */
  setDefaultEffort(id: string | undefined): void
  /** The session mode currently in force (matched from the session log, or
   *  the last one Shift+Tab applied). */
  readonly mode: SessionModeSpec
  /** Index of `mode` in the configured cycle; 0 is the unmarked base mode. */
  readonly modeIndex: number
  /** Shift+Tab: advance to the next configured session mode. */
  cycleMode(): Promise<void>
  backendChannels(): BackendChannelsHost | undefined
  backendModes(): BackendModesHost | undefined
  backendMcp(): BackendMcpHost | undefined
  /** Backend-owned `/init`; DSH keeps its synchronous initWorkspace path. */
  backendInit(): { run(): Promise<boolean> } | undefined
  /** `/goal` on a session with the typed `goals` capability; undefined
   *  otherwise (DSH's /goal is its command registry row). */
  backendGoals(): BackendGoalsHost | undefined
  /** Read the official permission preset roster and current identity. */
  permissionPresets(): PermissionPresetSnapshot
  /**
   * TUI-side permission preset switch: drives the durable `permission/preset`
   * path (the same handler the command drives). Resolves true when the
   * durable identity confirms the target. Never falls through to the model.
   */
  runPermissionPreset(name: string): Promise<boolean>
  /** The preset the CURRENT session runs under (issue #8), resolved from its
   *  log at create/resume time; undefined when no roster is mounted. */
  readonly agentPreset: string | undefined
  /** The roster's presets for the `/preset` picker (empty without a roster). */
  listPresets(): Promise<readonly PresetOption[]>
  /** Switch the agent preset (`/preset`): a blank session swaps composition
   *  in place (official `recompose` + logged `agent-preset/selected`); a
   *  started session is locked, so the choice persists as the default for
   *  future sessions instead. False when the roster is absent, the id is
   *  unknown/broken, or a turn is running. */
  switchPreset(presetId: string): Promise<boolean>
  /** Reset the visible transcript (`/clear`). */
  clear(): void
  /**
   * Re-render rows older than the current in-memory window from the session
   * log (rows beyond {@link ChannelState.rows}' cap are folded away; this
   * restores them for review). Returns the number of rows restored, 0 when
   * the whole log is already materialized.
   */
  loadOlder(): number
  /** Push a transient notification above the prompt input. Returns an
   *  early-dismiss handle (the auto-timeout still runs as the backstop). */
  notify(text: string, options?: { color?: NotificationItem['color']; timeoutMs?: number }): () => void
  /** Switch the working-activity indicator preset (`/activity`): validates
   *  the name, persists it to `~/.dsh-tui/working-activity.json`, and
   *  re-renders the indicator immediately; false when the name is unknown
   *  or the preference cannot be written. */
  setActivityFrames(name: string): boolean
  /** Advertised models across every registered provider route (empty when the LLM service is absent). */
  listModels(): Promise<readonly LlmModelInfo[]>
  /** Provider display identities for the same routes (picker group labels). */
  listProviders(): Promise<readonly LlmProviderInfo[]>
  /** Drop the `/model <provider/id>` completion cache so the next `/model `
   *  refetch reflects a provider-catalog change (`/provider` add/edit/delete,
   *  OAuth sign-in/out) — the same consistency the picker's per-open refetch
   *  already provides. */
  invalidateModelCompletion(): void
  /** The live agent's full skill catalog for `/skills` (issue #204) — name,
   *  description, invocation flags and source bucket. Undefined on a failed
   *  or incomplete registry read (the picker shows an error); empty only
   *  when no registry is mounted or it genuinely holds nothing. */
  listSkills(): Promise<readonly SkillInfo[] | undefined>
  /** Safe credential metadata for `/login`; undefined without the service. */
  describeCredential(ref: string): Promise<CredentialStatus | undefined>
  /** DeepSeek official account balance for `/balance`: resolves
   *  `DEEPSEEK_API_KEY` through the credentials seam (env fallback) and
   *  queries the official balance endpoint. The key is used only for the
   *  request header — never logged, printed or persisted. */
  balanceInfo(): Promise<BalanceResult>
  /** Runtime capabilities for the `/provider` wizard, over the settings /
   *  credentials / llm seams; undefined when the composition lacks them
   *  (bare cordis.yml start without the dsh-base services). */
  providerSetup(): ProviderSetupHost | undefined
  /** OAuth sign-in states from a mounted dsh-auth-style plugin; undefined
   *  without the plugin, so `/login` renders exactly what it did before. */
  oauthProviderStatuses(): Promise<readonly OAuthProviderStatus[] | undefined>
  /**
   * The bound backend session's own sign-in for `/login` (status lines, the
   * host's OAuth sign-in preselected on the backend's provider, reconnect on
   * the fresh credential); undefined for a DSH session, whose `/login`
   * reports the DSH credentials.
   */
  backendAuth(): BackendAuthHost | undefined
  /**
   * Runtime capabilities for the `/settings` screen, over the settings /
   * credentials seams; undefined when the composition lacks the settings
   * service (the screen then renders plugin sections as unavailable and
   * namespaces read-only).
   */
  settingsHost(): SettingsHost | undefined
  /** Plugin-declared settings sections from the `tuiSettingsSections` seam
   *  (empty when the seam or every provider is absent). */
  settingsSections(): readonly TuiSettingsSection[]
  /** Subscribe to settings-section register/unregister events. */
  subscribeSettingsSections(listener: () => void): () => void
  /** Structured `@` file completion, using the session's remote fs service. */
  listFileCandidates(query: string, options?: { signal?: AbortSignal; topK?: number }): Promise<readonly FileCandidate[]>
  /** Backward-compatible top-level/recursive listing. */
  listFiles(): Promise<readonly string[]>
  /** Every session the persistence backend stores, classified and unfiltered
   *  — the browser (`/resume`) decides which of them a given view shows. */
  /** Last successful source-scoped listing for first paint; never authoritative. */
  cachedSessions(): readonly SessionSummary[] | undefined
  listSessions(onEnriched?: (summary: SessionSummary) => void, onPartial?: (rows: readonly SessionSummary[]) => void): Promise<readonly SessionSummary[]>
  /** Other coding agents on this machine that have conversations (a cheap
   *  presence probe; nothing is read or remembered). */
  listForeignSources(): Promise<readonly ForeignSource[]>
  /** One source's conversations, newest first; `onRow` streams rows as the
   *  scan finds them. Unchanged conversations are not re-read within a run. */
  listForeignSessions(agentId: string, onRow?: (row: ForeignSessionRow) => void): Promise<readonly ForeignSessionRow[]>
  /** Import one foreign conversation unless already present; a repeat
   *  request for a conversation being imported joins the running import. */
  importForeignSession(agentId: string, key: string): Promise<ForeignImportOutcome>
  /** Trailing exchanges of a persisted session, for the browser's preview. */
  previewSession(sessionId: string): Promise<readonly PreviewEntry[]>
  /** Mark a session for `dsh-tui --resume` on the next launch. */
  setResumeTarget(sessionId: string): void
  /** Rename the current session (`/rename`): appends a `session/title`
   *  event, which the status line and the /resume picker both read. */
  renameSession(title: string): void
  /** Set the current session's accent color (`/color <name>`): appends a
   *  `session/color` event; '' clears it back to the theme default. */
  setSessionColor(color: string): void
  /** Generate a recap of the session's recent activity (`/recap`): one
   *  tool-less LLM call over the tail exchanges, returning a one-line
   *  summary plus an optional proposed title. The answer is pure UI state
   *  and never enters the session log. */
  recapRecent(options?: { signal?: AbortSignal; onText?: (delta: string) => void }): Promise<RecapOutcome>
  /** Delete a persisted session (`/resume` picker ctrl+d): removes its log
   *  directory, its last-used entry, and the resume marker when it points
   *  here. False for the live session or a missing/unwritable log. */
  deleteSession(sessionId: string): Promise<boolean>
  /** Rename any persisted session (`/resume` picker ctrl+r): appends a
   *  `session/title` event to its log (live sessions go through the normal
   *  rename path). False when the log is absent or undecodable. */
  renameSessionTo(sessionId: string, title: string): Promise<boolean>
  /** Manually compact the session history (`/compact`); no-op notify when the leaf lacks a compaction service. */
  compact(): void
  /** Abort an in-flight manual compaction (`Esc` while it runs). No-op when
   *  none is running or the running one belongs to another process/host: only
   *  this channel's own request carries an abort signal it may fire. */
  cancelCompact(): void
  /** Render a multi-line local report in the transcript (`/status`,
   *  `/doctor`, …): a `local` row plus one `local-output` row per line. */
  pushLocal(title: string, lines: readonly string[]): void
  /** MCP server/tool status for /mcp: one line per server, or setup guidance. */
  mcpStatus(): string[]
  /** Write the conversation transcript to `dsh-tui-export-<ts>.md` in the
   *  session cwd; returns the written path, or null on failure. */
  exportSession(): string | null
  /** Create `AGENTS.md` in the session cwd (DSH workspace-context file);
   *  returns the path, `'exists'` when already present, or null on failure. */
  initWorkspace(): string | null
  /** Environment diagnostics for `/doctor`. */
  doctorInfo(): string[]
  /** Plugin contract/grant/ledger diagnostics for `/plugins` (C-070 trust
   *  banner first line; `check <path>` runs validatePlugin + negotiate). */
  pluginsInfo(args: string): string[]
  /** Subagent rows for `/agents` (DSH subagent service; empty message when
   *  the service is absent). */
  listSubagents(): Promise<string[]>
  /**
   * The agent view row snapshot: every live agent in
   * this process plus every persisted session that no live agent owns,
   * ordered needs-input/working first, then most recently active. Reading it
   * is cheap; subscribe for changes.
   */
  agentViewRows(): readonly AgentViewRow[]
  /** Change feed for {@link agentViewRows}: fired on agent lifecycle/status
   *  changes and — throttled — on session events of background agents. */
  subscribeAgentView(listener: () => void): () => void
  /**
   * Dispatch a new background session (`agent view` input): creates an agent
   * in this process, delivers the prompt as a user message, and keeps the
   * TUI attached to its current session. The new session keeps running until
   * it finishes its turn or is stopped — it lives only while this process
   * does.
   */
  dispatchBackgroundAgent(prompt: string): Promise<AgentViewDispatchResult>
  /** Stop a background session (Ctrl+X): abort its turn and dispose its
   *  agent; the persisted log survives for resume. False for the attached
   *  session or one this TUI does not own. */
  stopBackgroundAgent(sessionId: string): Promise<boolean>
  /**
   * Attach the TUI terminal to a session (`agent view` Enter/→): a live
   * agent is adopted in place (its handle becomes the channel's), a
   * persisted one resumes through the persistence seam. The previously
   * attached agent is NOT disposed — it keeps running as a background
   * session unless it was already idle with no history.
   */
  attachToAgent(sessionId: string): Promise<ResumeResult>
  /** Trailing exchanges of any session — the live agent's in-memory log when
   *  it is alive in this process, the persisted artifact otherwise. */
  peekAgentSession(sessionId: string): Promise<readonly PreviewEntry[]>
  /** `/bg` — background the attached session: swap the TUI to a fresh agent
   *  while the current one keeps running. The agent view lists it as a
   *  background session; `backgroundedSessionId` is the move's return target
   *  ("Esc returns to that conversation"). */
  backgroundCurrent(): Promise<BackgroundResult>
  /** Send a follow-up user message to a session from the agent view's peek
   *  panel. Live sessions receive it directly; a session no live agent owns
   *  cannot take a reply (false + a notify to attach instead). */
  replyToAgent(sessionId: string, text: string): Promise<boolean>
  /**
   * Dispose the host-registry entries this channel registered (skill slash
   * commands).
   *
   * `commandService.register` binds the registration to ITS own context, not
   * the caller's, so the entries outlive this channel unless released: after a
   * launcher recompose the stale registrations would still answer, but the
   * fresh channel would see the names taken and stop managing them, freezing
   * the menu. The plugin calls this from its teardown effect, where the real
   * cordis context lives.
   */

  /**
   * The live agent's session event log (immutable snapshot, replaced on
   * every append — dsh-session caches the frozen array) — the `/trace`
   * trajectory view's data source. Screens already re-render on `version`
   * bumps, so a view reading this per render follows live events in real
   * time; agent swaps (/resume /rewind /new) are reflected immediately.
   */
  traceEvents(): readonly RawTrajEvent[]
  /**
   * The trajectory source's own three-state report (see
   * {@link TrajectorySource}): 'unsupported' when the composition mounted no
   * trajectory source at all, 'empty'/'supported' when it did (the DSH
   * extension reading its raw history; any other backend via the core's
   * AgentEvent fold). Every trajectory surface (/trace, Ctrl+T, the sidebar
   * tab, the ⤢ outlet) reads this instead of guessing from the event count,
   * so "not adapted yet" never shows up as "no turns yet".
   */
  trajectorySource(): TrajectorySource
  /**
   * The trajectory's drilldown lanes: every subagent whose child-lane
   * events the mounted source folded into their own log. A source that
   * attributes no lanes (DSH raw history today) answers an empty roster, and
   * the scope filter is then not offered rather than faked over the main
   * ledger.
   */
  trajectoryLanes(): readonly TrajectoryLane[]
  /**
   * One lane's own raw-event snapshot (`descendants` unset), or the agent's
   * whole subtree merged in emission order (`descendants` set). Same
   * append-only, prefix-identity contract as {@link traceEvents}, so the
   * scoped fold stays incremental like the main one.
   */
  trajectoryLaneEvents(agentId: string, descendants?: boolean): readonly RawTrajEvent[]
  /**
   * Localized one-phrase label naming the mounted trajectory source (the
   * raw DSH session log, or the backend-neutral AgentEvent fold), so the
   * fullscreen view says what it is reading instead of guessing from the
   * backend id.
   */
  trajectoryBackendLabel(): string
  setDiffLayout(layout: 'auto' | 'split' | 'unified'): void
  setThinkingFold(mode: 'preview' | 'full'): void
  setJobGroupFold(mode: JobGroupFoldMode): void
  setToolBackground(background: ToolBackground): void
  setScrollGutter(mode: ScrollGutterMode): void
  setPageMargin(setting: PageMarginSetting): void
  setFoldTerminalCommand(enabled: boolean): void
  setTurnUsageRow(enabled: boolean): void
  setPromptSessionLabel(enabled: boolean): void
  setExpandEditor(enabled: boolean): void
  setSmoothStreaming(enabled: boolean): void
  setStatusBar(config: Partial<StatusBarConfig>): void
  setWhale(visible: boolean): void
  setSplashFont(setting: SplashFontSetting): void
  /** Apply a minimal-UI change (see the public Channel type). */
  setMinimalUi(enabled: boolean): void
  /** @deprecated Pre-rename alias of {@link setMinimalUi}. Kept for plugin
   *  scenes that call `channel.setMinimal()`; use `setMinimalUi`.
   *
   *  REMOVAL: v0.13, under the same audit as `minimal` above — a scene-plugin
   *  consumption scan of `.minimal` / `.setMinimal(` with zero remaining
   *  callers. */
  setMinimal(enabled: boolean): void
}
