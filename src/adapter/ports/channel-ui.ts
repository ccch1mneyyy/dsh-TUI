/** Host-owned in-process Channel contract. No runtime or upstream imports. */
import type { ChatRow, AgentStatus, TokenUsage, NotificationItem, ActivityStatus, ChannelGoal, TodoPanelItem, LoadedContext, PendingMessage, ChannelSceneMetadata, SubagentState, SubagentControl, BackgroundJobState, JobControl, StagedImageInput, StagedImageHandle, ComposerImageRef, ComposerSubmission, ExternalCommandOutcome, TranscriptImage, ResumeResult, EffortOption, PermissionPresetSnapshot, PresetOption, LlmModelInfo, LlmProviderInfo, SkillInfo, CredentialStatus, AgentViewRow, AgentViewDispatchResult, BackgroundResult, RawTrajEvent } from './channel-view.js'
import type { SpinnerMode, ToolBackground, ScrollGutterMode, PageMarginSetting, StatusBarConfig, SessionModeSpec } from './channel-display.js'
import type { LocalCommand, CommandCompletion, BalanceResult, FileCandidate, RecapOutcome } from './channel-catalog.js'
import type { TuiRewindMode, SessionTreeData, SessionSummary, PreviewEntry } from './channel-session.js'
import type { TuiWorkspaceTarget, TuiWorkspaceCommand, TuiWorkspaceCommandResult } from './channel-workspace.js'
import type { ProviderSetupHost, OAuthProviderStatus, SettingsHost, TuiSettingsSection } from './channel-settings.js'

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
  readonly status: AgentStatus | 'starting' | 'disposed'
  readonly sessionTitle: string
  /** Per-session accent color name (`/color`), '' when unset — persisted via
   *  a `session/color` log event so it survives resume/rewind. Renders as
   *  the prompt-input border + session label chip accent (cc/sessionColors). */
  readonly sessionColor: string
  readonly agentId: string
  /** TUI-owned generation that changes on every live Agent rebind. */
  readonly agentBindingGeneration: number
  /** `dsh-tui.recapOnOpen` (default on): auto-summarize the session tail
   *  into the dim AutoRecapRow when the session opens/resumes. Read live
   *  (settings service), so a `/settings` change applies on the next
   *  session switch; absent settings service → on. */
  readonly autoRecapOnOpen: boolean
  /** Resolved model id (from the plugin config). */
  readonly model: string
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
  /** Working directory of the session. */
  readonly cwd: string
  /** Human-facing cwd (remote POSIX path/URI instead of a host alias). */
  readonly displayCwd: string
  /** Current git branch, when the cwd is inside a git worktree. */
  readonly gitBranch: string | undefined
  /** True between turn/start and turn/end — drives the working spinner. */
  readonly working: boolean
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
   *  this, not the running totals — each request's input IS the context). */
  readonly lastUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number }
    | undefined
  /** Output tokens per second of the current/last turn's response, when known. */
  readonly tps: number | undefined
  /** Per-turn tps samples (sparkline history), oldest first. */
  readonly tpsSamples: readonly { tps: number; at: number }[]
  /** Latest in-process working-activity snapshot. */
  readonly workingActivity: ActivityStatus | undefined
  /** Working-activity indicator preset name (`claude`/`moon`/…/`random`). */
  readonly activityFrames: string | undefined
  /** Edit/Write diff presentation preference (`auto`/`split`/`unified`). */
  readonly diffLayout: 'auto' | 'split' | 'unified'
  /** Thinking-block display (`preview` = 2-3 line live stream + fold per
   *  step; `full` = expanded until turn end). */
  readonly thinkingFold: 'preview' | 'full'
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
  /** Apply an idle-whale-behavior change (see the public Channel type). */
  setWhaleIdle(enabled: boolean): void
  /** Minimal mode (settings `dsh-tui.minimal`): no header splash, no emoji
   *  glyphs, no decorative colors; code highlight and tool colors stay. */
  readonly minimal: boolean
  /** Whether the in-process working-activity line is shown (config.activity). */
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
  /** 侧问（CC /btw）：无工具单轮 LLM 调用，复用当前会话上下文；结果不落 session log。 */
  sideQuestion(
    question: string,
    options?: { signal?: AbortSignal; onText?: (delta: string) => void },
  ): Promise<{ answer: string | null; error?: string }>
  /** Estimated context segments by content type (pi-nano-context style bar). */
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
  stagedImageLimits(): { readonly maxImageBytes: number; readonly maxImagesPerMessage: number } | undefined
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
  /** Abort the in-flight turn and process `texts` right away (Esc/Ctrl+Enter
   *  with queued input): each text is re-queued as a followup once the abort
   *  settles, so the new turn starts immediately. Returns the count queued. */
  interruptAndDeliver(inputs: readonly (string | ComposerSubmission)[]): number
  /** Rewind the conversation to a past user message (CC's double-Esc rewind):
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
   *  slider; empty `efforts` after notifying when unsupported/unavailable. */
  listEfforts(): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined }>
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
  listSessions(): Promise<readonly SessionSummary[]>
  /** Trailing exchanges of a persisted session, for the browser's preview. */
  previewSession(sessionId: string): Promise<readonly PreviewEntry[]>
  /** Mark a session for `dsh-tui --resume` on the next launch. */
  setResumeTarget(sessionId: string): void
  /** Rename the current session (CC's /rename): appends a `session/title`
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
  /** Manually compact the session history (CC's /compact); no-op notify when the leaf lacks a compaction service. */
  compact(): void
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
   * The agent view (CC's `claude agents`) row snapshot: every live agent in
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
   *  (CC's "Esc returns to that conversation"). */
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
  setDiffLayout(layout: 'auto' | 'split' | 'unified'): void
  setThinkingFold(mode: 'preview' | 'full'): void
  setToolBackground(background: ToolBackground): void
  setScrollGutter(mode: ScrollGutterMode): void
  setPageMargin(setting: PageMarginSetting): void
  setFoldTerminalCommand(enabled: boolean): void
  setPromptSessionLabel(enabled: boolean): void
  setExpandEditor(enabled: boolean): void
  setSmoothStreaming(enabled: boolean): void
  setStatusBar(config: Partial<StatusBarConfig>): void
  setWhale(visible: boolean): void
  setMinimal(enabled: boolean): void
}
