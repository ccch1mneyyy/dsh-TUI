import { type Agent, type AgentHandle, type AgentStatus } from '@deepseek-ai/dsh-agent';
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm';
import { type ContentBlock } from '@deepseek-ai/dsh-llm';
import { type SessionEvent } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import { type CommandCompletion, type LocalCommand } from '../commands.js';
import { type SessionRecord } from '../sessionHistory.js';
import type { ProviderSetupHost } from './providerWizard.js';
import { type SessionModeSpec } from '../sessionModes.js';
import type { SpinnerMode } from '../components/Spinner/spinnerMode.js';
import { type ActivityState } from 'dsh-working-activity/status';
import { type TuiWorkspaceCommand, type TuiWorkspaceCommandResult, type TuiWorkspaceTarget } from './workspaces.js';
type ChannelImageBlock = Extract<ContentBlock, {
    type: 'image';
}>;
type ChannelImageMediaType = ChannelImageBlock['attachment']['mediaType'];
export interface StagedImageInput {
    data: Uint8Array;
    mediaType: ChannelImageMediaType;
    name?: string;
}
/** Tool-call card state, mirroring the Claude Code tool-use presentation. */
export interface ToolRow {
    readonly callId: string;
    readonly name: string;
    /** Raw JSON arguments as the model produced them (displayed truncated). */
    readonly argsText: string;
    /** Full arguments, shown when Ctrl+O verbose mode is on; dropped when the
     *  row is folded (session log retains it). */
    argsFull?: string;
    status: 'running' | 'ok' | 'error';
    resultText?: string;
    /** Full result text, shown when Ctrl+O verbose mode is on. */
    resultFull?: string;
    errorText?: string;
    /** Tool-owned render intent from dsh-tools `presentCall` (diff/terminal/
     *  generic). Drives the structured card body instead of the raw text. */
    callView?: ToolCallView;
    /** Tool-owned completed-state view from `presentResult` (applied diff
     *  hunks, terminal output, read content…). Wins over callView once set. */
    resultView?: ToolResultView;
    /** Wall-clock start of the call (live elapsed while running). */
    startedAt: number;
    /** Settled wall-clock duration, written by tool/result. */
    durationMs?: number;
}
/** One file change in a tool presentation (dsh-tools FileDiff). */
export interface ToolFileDiff {
    readonly path: string;
    /** Prior content, or null for a new file / no before-image. */
    readonly oldText: string | null;
    readonly newText: string;
}
/** Pending-call render intent (structural subset of dsh-tools ToolCallView). */
export type ToolCallView = {
    readonly card: 'generic';
    readonly title: string;
    readonly kind?: string;
} | {
    readonly card: 'terminal';
    readonly title: string;
    readonly description?: string;
    readonly cwd?: string;
} | {
    readonly card: 'diff';
    readonly title: string;
    readonly diffs: readonly ToolFileDiff[];
};
/** Completed-call render intent (structural subset of dsh-tools
 *  ToolResultView). `web` results and unknown shapes fall back to raw text. */
export type ToolResultView = {
    readonly card: 'generic';
    readonly title?: string;
    readonly content?: ReadonlyArray<{
        readonly type: string;
        readonly text?: string;
    }>;
} | {
    readonly card: 'terminal';
    readonly title?: string;
    readonly output?: string;
    readonly exitCode?: number;
    readonly signal?: string;
} | {
    readonly card: 'diff';
    readonly title?: string;
    readonly diffs: readonly ToolFileDiff[];
} | {
    readonly card: 'read';
    readonly title?: string;
    readonly path?: string;
    readonly content?: ReadonlyArray<{
        readonly type: string;
        readonly text?: string;
    }>;
} | {
    readonly card: 'search';
    readonly shape: 'matches';
    readonly title?: string;
    readonly files: ReadonlyArray<{
        readonly path: string;
        readonly matches: ReadonlyArray<{
            readonly lineNumber: number;
            readonly line: string;
        }>;
    }>;
    readonly truncated: boolean;
    readonly total: number;
} | {
    readonly card: 'search';
    readonly shape: 'paths';
    readonly title?: string;
    readonly paths: readonly string[];
    readonly truncated: boolean;
    readonly total: number;
};
/** Re-derives the presentation views foldRows dropped, threaded into
 *  foldBack (module-level, no ctx access) by the channel. */
export interface ToolViewPresenter {
    call(name: string, rawArgs: string): ToolCallView | undefined;
    result(name: string, rawArgs: string, data: SessionEvent<'tool/result'>['data']): ToolResultView | undefined;
}
/**
 * One rendered transcript row. The DSH session log is the source of truth:
 * rows are derived from `session/event` records (and the initial
 * `agent.session.events` replay), never from optimistic local state.
 */
export interface ChatRow {
    id: number;
    kind: 'user' | 'assistant' | 'tool' | 'notice' | 'reasoning' | 'interrupt' | 'local' | 'local-output' | 'compact';
    /** Extra label for non-human user rows (e.g. `steering`). */
    label?: string;
    /** Actual execution location for `!command` rows. */
    executionTarget?: string;
    text: string;
    /** True while an assistant step is still streaming chunks. */
    streaming?: boolean;
    /** Present on `tool` rows; the card model. */
    tool?: ToolRow;
    /** Event wall-clock time (transcript-mode metadata, assistant rows). */
    time?: number;
    /** Present on `reasoning` rows once settled: thinking wall-clock duration. */
    durationMs?: number;
    /** Source session event seq — present on every log-derived row (rewind
     *  fork anchor on user rows; window-floor bookkeeping for the rest). */
    seq?: number;
    /** True when the row's full text was folded to keep the transcript window
     *  bounded (see MAX_ROWS); the session log still holds the full content
     *  and loadOlder() restores it. */
    folded?: boolean;
    /** True when loadOlder() restored this row from the log; restored rows are
     *  exempt from the next fold pass so a restore is not instantly undone. */
    restored?: boolean;
}
/** Running token totals across the session's assistant messages. */
export interface TokenUsage {
    input: number;
    output: number;
}
/** In-process working-line snapshot derived from the base session stream. */
export type ActivityStatus = ActivityState;
/** A transient status message shown above the prompt input. */
export interface NotificationItem {
    id: number;
    text: string;
    /** Theme color key; defaults to dim. */
    color?: 'error' | 'warning' | 'success';
    /** Auto-dismiss after this many ms (default 4000). */
    timeoutMs: number;
}
/**
 * Durable same-session goal projection surfaced on the channel (see
 * {@link Channel['goal']}). Mirrors the goal domain's `GoalSnapshot` +
 * replay counters; declared locally so the UI needs no dsh-goal dependency.
 */
export interface ChannelGoal {
    id: string;
    revision: number;
    objective: string;
    phase: 'active' | 'paused' | 'blocked' | 'complete';
    /** Total admitted goal-round cap. */
    maxGoalRounds: number;
    /** Highest admitted continuation round so far. */
    roundsStarted: number;
    /** Present exactly while `phase` is `blocked`. */
    blockedReason?: {
        code: string;
        message: string;
    };
}
/** One entry of the latest todo-list snapshot (mirrors the session domain's
 *  `TodoItem`; declared locally for the same reason as {@link ChannelGoal}). */
export interface TodoPanelItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
}
/** One named prompt contribution with its model-visible text. */
export interface LoadedContextEntry {
    /** Provider-declared name (e.g. `harness:identity`, `deployment:persona`). */
    readonly name: string;
    /** The interpolated text the model receives for this entry. */
    readonly text: string;
}
/** One discovered workspace instruction file (AGENTS.md-family). */
export interface LoadedContextFile {
    /** Model-facing path (e.g. `./AGENTS.md`). */
    readonly displayPath: string;
}
/** One model-invocable skill from the skill registry. */
export interface LoadedContextSkill {
    readonly name: string;
    readonly description: string;
}
/** One model-visible tool from the prompt assembly. */
export interface LoadedContextTool {
    readonly name: string;
    readonly description: string;
}
/**
 * Snapshot of everything a fresh conversation for the current agent will
 * load: the assembled system prompt (ordered sections, dynamic context,
 * tools), the workspace instruction files baseline discovery would inject,
 * and the skill catalog. Declared locally so screens and helpers consume a
 * self-contained contract instead of the dsh-system-prompt/dsh-skill types.
 */
export interface LoadedContext {
    /** Ordered system-prompt sections after strict variable interpolation. */
    readonly sections: readonly LoadedContextEntry[];
    /** Dynamic context contributions (runtime snapshot parts). */
    readonly contexts: readonly LoadedContextEntry[];
    /** Workspace instruction files (AGENTS.md-family) discovered for the cwd. */
    readonly files: readonly LoadedContextFile[];
    /** Model-invocable skills, when the skill registry is mounted. */
    readonly skills: readonly LoadedContextSkill[];
    /** Model-visible tools in assembly order. */
    readonly tools: readonly LoadedContextTool[];
}
/**
 * The public channel surface a screen renders: the full transcript and live
 * status snapshot (tokens, spinner, working activity, goals, todos, loaded
 * context) plus every action the TUI can take (submit, steer, cancel,
 * rewind, resume, model switching, …). Implementations mutate internal state
 * and bump `version` so subscribed screens re-render.
 */
export interface Channel {
    /** Monotonic version — bump on every mutation so screens can re-render. */
    readonly version: number;
    readonly rows: readonly ChatRow[];
    readonly status: AgentStatus | 'starting' | 'disposed';
    readonly sessionTitle: string;
    readonly agentId: string;
    /** Resolved model id (from the plugin config). */
    readonly model: string;
    /** Provider route of the live agent. */
    readonly provider: string;
    /** Running token totals across the session's assistant messages. */
    readonly tokens: TokenUsage;
    /** Working directory of the session. */
    readonly cwd: string;
    /** Human-facing cwd (remote POSIX path/URI instead of a host alias). */
    readonly displayCwd: string;
    /** Current git branch, when the cwd is inside a git worktree. */
    readonly gitBranch: string | undefined;
    /** True between turn/start and turn/end — drives the working spinner. */
    readonly working: boolean;
    /** Which phase the spinner should present while working. */
    readonly spinnerMode: SpinnerMode;
    /** Chars streamed as text this turn (feeds the spinner token counter). */
    readonly responseChars: number;
    /** Number of tool calls still in flight this turn. */
    readonly activeToolCount: number;
    /** Wall-clock ms of turn/start (spinner elapsed timer). */
    readonly turnStart: number;
    /** Last user prompt text (sticky header + statusline). */
    readonly lastUserText: string;
    /** Transient notifications, newest last. */
    readonly notifications: readonly NotificationItem[];
    /** Adapter-advertised context capacity for the model route, when known. */
    readonly contextWindow: number | undefined;
    /** Reasoning effort of the latest request header, when the adapter sets one. */
    readonly reasoningEffort: string | undefined;
    /** Usage of the most recent request (context share + cache hits come from
     *  this, not the running totals — each request's input IS the context). */
    readonly lastUsage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    } | undefined;
    /** Output tokens per second of the current/last turn's response, when known. */
    readonly tps: number | undefined;
    /** Per-turn tps samples (sparkline history), oldest first. */
    readonly tpsSamples: readonly {
        tps: number;
        at: number;
    }[];
    /** Latest in-process working-activity snapshot. */
    readonly workingActivity: ActivityStatus | undefined;
    /** Working-activity indicator preset name (`claude`/`moon`/…/`random`). */
    readonly activityFrames: string | undefined;
    /** Whether the in-process working-activity line is shown (config.activity). */
    readonly activityEnabled: boolean;
    /** Whether the segmented context bar row shows in the status footer
     *  (config.contextBar; the status/mode lines are unaffected). */
    readonly contextBarEnabled: boolean;
    /**
     * Current same-session goal projection, when a goal exists. Derived live
     * from the durable `goal/change` context events (round-zero goal-sourced
     * user messages) in the session log — every goal mutation appends one, so
     * this snapshot tracks create/edit/pause/resume/complete/block/clear in
     * real time and replays correctly on resume/rewind.
     */
    readonly goal: ChannelGoal | undefined;
    /**
     * Latest todo-list snapshot (`todo/write` whole-list event, last write
     * wins). Log-only UI state, updated live and on replay.
     */
    readonly todos: readonly TodoPanelItem[];
    /**
     * Snapshot of the context a fresh conversation for this agent will load
     * (system prompt sections, dynamic context, workspace instructions, skill
     * catalog, tools), computed at boot and on every agent swap. `undefined`
     * while loading or when the snapshot could not be assembled — the startup
     * panel stays hidden until it lands.
     */
    readonly loadedContext: LoadedContext | undefined;
    /**
     * Messages submitted while the model was working and not yet claimed by a
     * turn (`steer` → next step boundary of the running turn, `followup` →
     * after the turn ends). Driven by agent inbox events.
     */
    readonly pending: readonly PendingMessage[];
    /**
     * Effective slash commands: built-in locals plus plugin-registered
     * commands (plan/goal/…) merged from the DSH command registry. The
     * registry is the source of truth for external names — a plugin shadows
     * nothing here; locals win on name collisions.
     */
    readonly commandList: readonly LocalCommand[];
    /** Context-aware slash completions, including plugin subcommands. */
    commandCompletions(input: string): readonly CommandCompletion[];
    /**
     * Run a plugin-registered slash command against the live agent (DSH
     * `dsh-commands` registry): logs `command/run`/`command/done` and returns
     * the handler's result text — `''` when the handler succeeded silently,
     * `undefined` when the registry has no such command (the caller falls
     * back to sending the line to the model).
     */
    runExternalCommand(name: string, rawInput: string): Promise<string | undefined>;
    /** 侧问（CC /btw）：无工具单轮 LLM 调用，复用当前会话上下文；结果不落 session log。 */
    sideQuestion(question: string, options?: {
        signal?: AbortSignal;
        onText?: (delta: string) => void;
    }): Promise<{
        answer: string | null;
        error?: string;
    }>;
    /** Estimated context segments by content type (pi-nano-context style bar). */
    readonly contextSegments: {
        system: number;
        prompt: number;
        assistant: number;
        thinking: number;
        tools: number;
    };
    subscribe: (listener: () => void) => () => void;
    /** Validate and persist a pasted image, returning its prompt placeholder. */
    stageImage(input: StagedImageInput): Promise<string>;
    submit(text: string): void;
    /**
     * Steer a message into the running turn (Codex/pi semantics): injected at
     * the next step boundary, the agent continues without aborting.
     */
    steer(text: string): void;
    /** Pull a pending message back out of the inbox (Alt+Up) for re-editing. */
    removePending(id: string): boolean;
    /** Abort the in-flight turn (`Ctrl+C` while working). */
    cancel(): void;
    /** Abort the in-flight turn and process `texts` right away (Esc/Ctrl+Enter
     *  with queued input): each text is re-queued as a followup once the abort
     *  settles, so the new turn starts immediately. Returns the count queued. */
    interruptAndDeliver(texts: readonly string[]): number;
    /** Rewind the conversation to a past user message (CC's double-Esc rewind):
     *  forks the session through that message, swaps in a fresh agent, and
     *  returns the message text for re-editing — or `null` when unwritable. */
    rewindTo(row: ChatRow): Promise<string | null>;
    /** Switch the live agent to a persisted session, replaying its history. */
    resumeTo(sessionId: string): Promise<boolean>;
    /** Start a fresh conversation (`/new`): a brand-new agent + session, the
     *  transcript cleared, the resume marker forgotten. */
    newSession(): Promise<boolean>;
    /** Workspace targets contributed by the TUI and optional providers. */
    listWorkspaces(): Promise<readonly TuiWorkspaceTarget[]>;
    /** Resolve an absolute path, file URL, or provider URI. */
    resolveWorkspace(reference: string): Promise<TuiWorkspaceTarget | undefined>;
    /** Start a fresh session in the selected workspace. */
    switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean>;
    /** Rename the current durable workspace. */
    renameWorkspace(title: string): Promise<boolean>;
    /** Provider-owned workspace subcommands. */
    workspaceCommands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[];
    runWorkspaceCommand(name: string, input: string): Promise<TuiWorkspaceCommandResult | undefined>;
    /** Switch the live model (`/model` picker): forks the conversation at its
     *  current end and continues it with a new agent routed to `provider`/`model`.
     *  The history replays unchanged; only the request route changes. */
    switchModel(provider: string, model: string): Promise<boolean>;
    /** The live route's effort levels + adapter default for the `/effort`
     *  slider; empty `efforts` after notifying when unsupported/unavailable. */
    listEfforts(): Promise<{
        efforts: readonly EffortOption[];
        defaultEffort: string | undefined;
    }>;
    /** Set one effort level by id (validated against the adapter list);
     *  false + a notify when the id is not offered. Persists like the old
     *  Shift+Tab cycle (~/.dsh-tui/effort.json). */
    setEffort(id: string): Promise<boolean>;
    /** The session mode currently in force (matched from the session log, or
     *  the last one Shift+Tab applied). */
    readonly mode: SessionModeSpec;
    /** Index of `mode` in the configured cycle; 0 is the unmarked base mode. */
    readonly modeIndex: number;
    /** Shift+Tab: advance to the next configured session mode. */
    cycleMode(): Promise<void>;
    /** The preset the CURRENT session runs under (issue #8), resolved from its
     *  log at create/resume time; undefined when no roster is mounted. */
    readonly agentPreset: string | undefined;
    /** The roster's presets for the `/preset` picker (empty without a roster). */
    listPresets(): Promise<readonly PresetOption[]>;
    /** Switch the agent preset (`/preset`): a blank session swaps composition
     *  in place (official `recompose` + logged `agent-preset/selected`); a
     *  started session is locked, so the choice persists as the default for
     *  future sessions instead. False when the roster is absent, the id is
     *  unknown/broken, or a turn is running. */
    switchPreset(presetId: string): Promise<boolean>;
    /** Reset the visible transcript (`/clear`). */
    clear(): void;
    /**
     * Re-render rows older than the current in-memory window from the session
     * log (rows beyond {@link ChannelState.rows}' cap are folded away; this
     * restores them for review). Returns the number of rows restored, 0 when
     * the whole log is already materialized.
     */
    loadOlder(): number;
    /** Push a transient notification above the prompt input. */
    notify(text: string, options?: {
        color?: NotificationItem['color'];
        timeoutMs?: number;
    }): void;
    /** Switch the working-activity indicator preset (`/activity`): validates
     *  the name, persists it to `~/.dsh-tui/working-activity.json`, and
     *  re-renders the indicator immediately; false when the name is unknown
     *  or the preference cannot be written. */
    setActivityFrames(name: string): boolean;
    /** Advertised models across every registered provider route (empty when the LLM service is absent). */
    listModels(): Promise<readonly LlmModelInfo[]>;
    /** Runtime capabilities for the `/provider` wizard, over the settings /
     *  credentials / llm seams; undefined when the composition lacks them
     *  (bare cordis.yml start without the dsh-base services). */
    providerSetup(): ProviderSetupHost | undefined;
    /** Top-level entries of the session cwd for `@` file completion. */
    listFiles(): Promise<readonly string[]>;
    /** Recent sessions recorded by the DSH persistence backend (for `/resume`). */
    listSessions(): Promise<readonly SessionRecord[]>;
    /** Mark a session for `dsh-tui --resume` on the next launch. */
    setResumeTarget(sessionId: string): void;
    /** Rename the current session (CC's /rename): appends a `session/title`
     *  event, which the status line and the /resume picker both read. */
    renameSession(title: string): void;
    /** Delete a persisted session (`/resume` picker ctrl+d): removes its log
     *  directory, its last-used entry, and the resume marker when it points
     *  here. False for the live session or a missing/unwritable log. */
    deleteSession(sessionId: string): Promise<boolean>;
    /** Rename any persisted session (`/resume` picker ctrl+r): appends a
     *  `session/title` event to its log (live sessions go through the normal
     *  rename path). False when the log is absent or undecodable. */
    renameSessionTo(sessionId: string, title: string): Promise<boolean>;
    /** Manually compact the session history (CC's /compact); no-op notify when the leaf lacks a compaction service. */
    compact(): void;
    /** Render a multi-line local report in the transcript (`/status`,
     *  `/doctor`, …): a `local` row plus one `local-output` row per line. */
    pushLocal(title: string, lines: readonly string[]): void;
    /** MCP server/tool status for /mcp: one line per server, or setup guidance. */
    mcpStatus(): string[];
    /** Write the conversation transcript to `dsh-tui-export-<ts>.md` in the
     *  session cwd; returns the written path, or null on failure. */
    exportSession(): string | null;
    /** Create `AGENTS.md` in the session cwd (DSH workspace-context file);
     *  returns the path, `'exists'` when already present, or null on failure. */
    initWorkspace(): string | null;
    /** Environment diagnostics for `/doctor`. */
    doctorInfo(): string[];
    /** Subagent rows for `/agents` (DSH subagent service; empty message when
     *  the service is absent). */
    listSubagents(): Promise<string[]>;
    /**
     * The live agent's session event log (immutable snapshot, replaced on
     * every append — dsh-session caches the frozen array) — the `/trace`
     * trajectory view's data source. Screens already re-render on `version`
     * bumps, so a view reading this per render follows live events in real
     * time; agent swaps (/resume /rewind /new) are reflected immediately.
     */
    traceEvents(): readonly SessionEvent[];
}
/** @internal */
/** One roster entry in the `/preset` picker (see {@link Channel.listPresets}). */
export interface PresetOption {
    id: string;
    name?: string;
    description?: string;
    /** Present when the roster marked this preset unloadable (shown verbatim). */
    broken?: string;
    isDefault: boolean;
}
/** @internal */
/** One user message submitted while the model was working, not yet claimed
 *  by a turn. `steer` lands at the next step boundary of the running turn;
 *  `followup` waits for the turn to end. */
export interface PendingMessage {
    id: string;
    text: string;
    placement: 'steer' | 'followup';
}
/**
 * Mutable channel state owned by {@link createChannel}: the screen's
 * reactive store. Screens subscribe and re-render on `version` bumps; the
 * fields mirror the public {@link Channel} contract, and the `@internal`
 * emit hooks belong to the implementation.
 */
/** One adapter-owned reasoning-effort level for the `/effort` slider. */
export interface EffortOption {
    id: string;
    name: string;
    description?: string;
}
export interface ChannelState {
    version: number;
    rows: ChatRow[];
    status: AgentStatus | 'starting' | 'disposed';
    sessionTitle: string;
    agentId: string;
    model: string;
    provider: string;
    tokens: TokenUsage;
    cwd: string;
    displayCwd: string;
    gitBranch: string | undefined;
    working: boolean;
    spinnerMode: SpinnerMode;
    responseChars: number;
    activeToolCount: number;
    turnStart: number;
    lastUserText: string;
    notifications: NotificationItem[];
    /** Adapter-advertised context capacity for the model route, when known. */
    contextWindow: number | undefined;
    /** Reasoning effort of the latest request header, when the adapter sets one. */
    reasoningEffort: string | undefined;
    /** Usage of the most recent request (context share + cache hits). */
    lastUsage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    } | undefined;
    /** Output tokens per second of the current/last turn's response, when known. */
    tps: number | undefined;
    /** Per-turn tps samples (sparkline history), oldest first. */
    tpsSamples: {
        tps: number;
        at: number;
    }[];
    /** Latest working-activity snapshot (see the public Channel type). */
    workingActivity: ActivityStatus | undefined;
    /** Working-activity indicator preset (see the public Channel type). */
    activityFrames: string | undefined;
    /** Working-activity display switch (see the public Channel type). */
    activityEnabled: boolean;
    /** Context bar row switch (see the public Channel type). */
    contextBarEnabled: boolean;
    /** Current same-session goal projection (see the public Channel type). */
    goal: ChannelGoal | undefined;
    /** Latest todo-list snapshot (see the public Channel type). */
    todos: TodoPanelItem[];
    /** Loaded-context snapshot (see the public Channel type). */
    loadedContext: LoadedContext | undefined;
    /** Messages submitted while working, awaiting their turn/step boundary.
     *  Driven by agent inbox events (inserted/claimed/discarded). */
    pending: PendingMessage[];
    /** 侧问（见 public Channel.sideQuestion）。 */
    sideQuestion(question: string, options?: {
        signal?: AbortSignal;
        onText?: (delta: string) => void;
    }): Promise<{
        answer: string | null;
        error?: string;
    }>;
    /** Effective slash commands (see the public Channel type). */
    commandList: readonly LocalCommand[];
    /** Context-aware slash completions (see the public Channel type). */
    commandCompletions(input: string): readonly CommandCompletion[];
    /** Run a plugin-registered command (see the public Channel type). */
    runExternalCommand(name: string, rawInput: string): Promise<string | undefined>;
    /** Estimated context segments by content type (pi-nano-context style bar). */
    contextSegments: {
        system: number;
        prompt: number;
        assistant: number;
        thinking: number;
        tools: number;
    };
    subscribe: (listener: () => void) => () => void;
    stageImage(input: StagedImageInput): Promise<string>;
    /** @internal event bump (the public `notify(text)` posts a notification). */
    emit(): void;
    /** @internal frame-aligned emit for high-frequency streaming deltas:
     *  version bumps synchronously but listeners fire at most once per 16ms
     *  window (trailing edge). */
    emitStream(): void;
    submit(text: string): void;
    steer(text: string): void;
    removePending(id: string): boolean;
    cancel(): void;
    /** @internal interrupt-and-deliver (see the public Channel type). */
    interruptAndDeliver(texts: readonly string[]): number;
    rewindTo(row: ChatRow): Promise<string | null>;
    /** Switch the live agent to a persisted session, replaying its history. */
    resumeTo(sessionId: string): Promise<boolean>;
    /** Start a fresh conversation (`/new`). */
    newSession(): Promise<boolean>;
    listWorkspaces(): Promise<readonly TuiWorkspaceTarget[]>;
    resolveWorkspace(uri: string): Promise<TuiWorkspaceTarget | undefined>;
    switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean>;
    renameWorkspace(title: string): Promise<boolean>;
    workspaceCommands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[];
    runWorkspaceCommand(name: string, input: string): Promise<TuiWorkspaceCommandResult | undefined>;
    /** Switch the live model (`/model` picker). */
    switchModel(provider: string, model: string): Promise<boolean>;
    /** The route's effort levels for `/effort` (see the public Channel type). */
    listEfforts(): Promise<{
        efforts: readonly EffortOption[];
        defaultEffort: string | undefined;
    }>;
    /** Set one effort level by id (see the public Channel type). */
    setEffort(id: string): Promise<boolean>;
    /** The session mode currently in force (see the public Channel type). */
    mode: SessionModeSpec;
    /** Index of `mode` in the configured cycle (see the public Channel type). */
    modeIndex: number;
    /** Shift+Tab session-mode advance (see the public Channel type). */
    cycleMode(): Promise<void>;
    /** The preset the current session runs under (see the public Channel type). */
    agentPreset: string | undefined;
    /** The roster's presets for the `/preset` picker (see the public Channel type). */
    listPresets(): Promise<readonly PresetOption[]>;
    /** Switch the agent preset (see the public Channel type). */
    switchPreset(presetId: string): Promise<boolean>;
    clear(): void;
    /** @internal older-row restoration (see the public Channel.loadOlder). */
    loadOlder(): number;
    notify(text: string, options?: {
        color?: NotificationItem['color'];
        timeoutMs?: number;
    }): void;
    /** Switch the working-activity indicator preset (see the public Channel). */
    setActivityFrames(name: string): boolean;
    listModels(): Promise<readonly LlmModelInfo[]>;
    /** `/provider` wizard capabilities (see the public Channel type). */
    providerSetup(): ProviderSetupHost | undefined;
    listFiles(): Promise<readonly string[]>;
    listSessions(): Promise<readonly SessionRecord[]>;
    setResumeTarget(sessionId: string): void;
    /** Rename the current session (see the public Channel type). */
    renameSession(title: string): void;
    /** Delete a persisted session (see the public Channel type). */
    deleteSession(sessionId: string): Promise<boolean>;
    /** Rename any persisted session (see the public Channel type). */
    renameSessionTo(sessionId: string, title: string): Promise<boolean>;
    /** Manually compact the session history (CC's /compact). */
    compact(): void;
    /** Multi-line local report (`/status`, `/doctor`, …). */
    pushLocal(title: string, lines: readonly string[]): void;
    /** MCP server/tool status for /mcp: one line per server, or setup guidance. */
    mcpStatus(): string[];
    /** Export the transcript to a markdown file (CC's /export). */
    exportSession(): string | null;
    /** Create `AGENTS.md` in the session cwd (CC's /init). */
    initWorkspace(): string | null;
    /** Environment diagnostics (CC's /doctor). */
    doctorInfo(): string[];
    /** Subagent rows (CC's /agents). */
    listSubagents(): Promise<string[]>;
    /** Live session event log (see the public Channel type, `/trace`). */
    traceEvents(): readonly SessionEvent[];
}
/**
 * Create the live channel state for one agent session: replay the durable
 * transcript, subscribe to the agent's events, and expose every TUI action.
 * @internal
 * @param ctx - The plugin context; optional services are resolved via ctx.get.
 * @param initialAgent - The agent whose session the channel renders; rewinds,
 *   resumes, and model switches replace it.
 * @param options - Boot options: model route, cwd, provider, and the
 *   reasoning-effort / working-activity / agent-handle preferences.
 * @returns The live channel state, subscribed and ready to render.
 */
export declare function createChannel(ctx: Context, initialAgent: Agent, options: {
    model: string;
    cwd: string;
    provider: string;
    /** Configured reasoning effort: applied to the agent's requests when the
     *  live route offers it (silently ignored otherwise), and shown from
     *  startup until the first request/header event reports the adapter's
     *  live value. */
    effort?: string;
    /** Derive the working line from base session events; default on. */
    activity?: boolean;
    /** Indicator preset for the working-activity line (`claude`/`moon`/
     *  `comet`/`dots`/… or `random`); default `claude`. */
    activityFrames?: string;
    /** Show the segmented context bar row in the status footer; default on
     *  (cordis.yml `contextBar: false` hides it, issue #29). */
    contextBar?: boolean;
    /** cordis.yml's static preset choice (`preset` key): wins over the
     *  persisted `/preset` preference for NEW sessions this channel starts. */
    configuredPreset?: string;
    /** cordis.yml's static route (`provider`/`model` keys), undefined when
     *  unset: wins over the persisted `/model` preference for NEW sessions
     *  only when BOTH halves are pinned (atomic rule, issue #67), and is the
     *  only route a resume overrides the target's own record with. */
    configuredProvider?: string;
    configuredModel?: string;
    /** The preset the initial agent's session runs under (from resolveAgent). */
    agentPreset?: string;
    /** Shift+Tab session-mode cycle from cordis.yml `modes`; undefined →
     *  the built-in default/plan/full cycle (sessionModes.ts). */
    modes?: readonly SessionModeSpec[];
    /** Handle of the initial agent; disposed when a rewind replaces it. */
    handle?: AgentHandle;
}): ChannelState;
/**
 * `/resume` project filter (issue #96): exact cwd match, PLUS sessions
 * recorded in a subdirectory — pre-upgrade launches recorded the launch
 * subdirectory as the header cwd, and with the cwd default now resolving to
 * the git worktree root an exact match would hide those sessions forever.
 * They belong to the same workspace, so they stay listed. Comparison follows
 * the platform's filesystem semantics (case-insensitive on Windows — a
 * pre-upgrade header may record `C:\Repo` where the current launch resolves
 * `c:\repo`). `caseInsensitive` is a parameter (not a platform read) so the
 * verifier can exercise both modes on any host. Exported for
 * scripts/verify-session-cwd.mjs.
 */
export declare function sessionCwdMatches(stateCwd: string, headerCwd: string, caseInsensitive?: boolean): boolean;
/** The fs-service surface `@`-mention expansion consumes (dsh-fs-local). */
export interface MentionFs {
    resolve(path: string): Promise<{
        displayPath: string;
    }>;
    stat(target: {
        displayPath: string;
    }): Promise<{
        type: 'file' | 'directory' | 'other';
    } | undefined>;
    readText(target: {
        displayPath: string;
    }): Promise<string>;
    readBytes?(target: {
        displayPath: string;
    }, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
    listDir(target: {
        displayPath: string;
    }): Promise<Array<{
        name: string;
        type: 'file' | 'directory' | 'other';
    }>>;
}
type MentionImageBlock = ChannelImageBlock;
type MentionImageMediaType = ChannelImageMediaType;
/** Attachment subset used to turn an image path into a durable user block. */
export interface MentionAttachments {
    readonly imageLimits: {
        readonly maxImageBytes: number;
        readonly maxImagesPerMessage: number;
        readonly maxMessageImageBytes: number;
        readonly mediaTypes: readonly MentionImageMediaType[];
    };
    saveImage(input: {
        data: Uint8Array;
        mediaType: MentionImageMediaType;
        name?: string;
    }): Promise<MentionImageBlock['attachment']>;
}
export interface MentionExpansion {
    /** Model-facing blocks: the typed text first, one block per attachment. */
    blocks: ContentBlock[];
    /** Paths that resolved and were attached (for the confirmation notice). */
    attached: string[];
    /** Mention tokens that failed to resolve (kept literal, warned about). */
    missing: string[];
}
/**
 * Expand a submitted text's `@` mentions (issue #15) into model-facing
 * attachment blocks: supported image files become durable image blocks,
 * other files contribute capped text, and directories contribute a shallow
 * listing. Reads always go through the active fs service, so provider-owned
 * workspaces keep their routing semantics. The typed text stays first and
 * verbatim. Best-effort failures degrade to `missing`, never a failed send.
 */
export declare function expandMentions(fs: MentionFs | undefined, cwd: string, text: string, attachments?: MentionAttachments, stagedImages?: ReadonlyMap<string, MentionImageBlock['attachment']>): Promise<MentionExpansion>;
export {};
//# sourceMappingURL=channel.d.ts.map