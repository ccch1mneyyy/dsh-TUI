import { type Agent, type AgentHandle, type AgentStatus } from '@deepseek-ai/dsh-agent';
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm';
import type { Context } from 'cordis';
import { type LocalCommand } from './commands.js';
import { type SessionRecord } from './sessionHistory.js';
import type { SpinnerMode } from './components/Spinner/spinnerMode.js';
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
    /** Wall-clock start of the call (live elapsed while running). */
    startedAt: number;
    /** Settled wall-clock duration, written by tool/result. */
    durationMs?: number;
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
export interface TokenUsage {
    input: number;
    output: number;
}
/**
 * Latest `activity/status` snapshot (the log-only event appended by
 * `@deepseek-ai/dsh-working-activity` for any UI consumer): the model's
 * live working line — thinking copy, running tool, turn summary. cc-tui
 * renders it on the status line; nothing here requires the plugin (absent
 * events simply leave the slot empty).
 */
export interface ActivityStatus {
    readonly phase: 'idle' | 'waiting' | 'thinking' | 'tool' | 'done';
    /** Human-readable status line (plain text, no ANSI). */
    readonly line: string;
    readonly label?: string;
    readonly detail?: string;
    readonly phrase?: string;
    readonly toolCount: number;
    readonly turnElapsedMs: number;
}
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
export interface Channel {
    /** Monotonic version — bump on every mutation so screens can re-render. */
    readonly version: number;
    readonly rows: readonly ChatRow[];
    readonly status: AgentStatus | 'starting' | 'disposed';
    readonly sessionTitle: string;
    readonly agentId: string;
    /** Resolved model id (from the plugin config). */
    readonly model: string;
    /** Running token totals across the session's assistant messages. */
    readonly tokens: TokenUsage;
    /** Working directory of the session. */
    readonly cwd: string;
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
    /** Per-message tps samples (sparkline + μ/p95 readout), oldest first. */
    readonly tpsSamples: readonly {
        tps: number;
        at: number;
    }[];
    /** Latest working-activity snapshot (log-only `activity/status` event),
     *  when the leaf mounts dsh-working-activity. */
    readonly workingActivity: ActivityStatus | undefined;
    /** Working-activity indicator preset name (`claude`/`moon`/…/`random`). */
    readonly activityFrames: string | undefined;
    /** Whether working-activity events are consumed (config.activity). */
    readonly activityEnabled: boolean;
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
    /**
     * Run a plugin-registered slash command against the live agent (DSH
     * `dsh-commands` registry): logs `command/run`/`command/done` and returns
     * the handler's result text — `''` when the handler succeeded silently,
     * `undefined` when the registry has no such command (the caller falls
     * back to sending the line to the model).
     */
    runExternalCommand(name: string, rawInput: string): Promise<string | undefined>;
    /** Estimated context segments by content type (pi-nano-context style bar). */
    readonly contextSegments: {
        system: number;
        prompt: number;
        assistant: number;
        thinking: number;
        tools: number;
    };
    subscribe: (listener: () => void) => () => void;
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
    /** Switch the live model (`/model` picker): forks the conversation at its
     *  current end and continues it with a new agent routed to `model`. The
     *  history replays unchanged; only the request model changes. */
    switchModel(model: string): Promise<boolean>;
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
     *  the name, persists it to `~/.dsh-cc/working-activity.json`, and
     *  re-renders the indicator immediately; false when the name is unknown
     *  or the preference cannot be written. */
    setActivityFrames(name: string): boolean;
    /** Advertised models for the configured provider route (empty when the LLM service is absent). */
    listModels(): Promise<readonly LlmModelInfo[]>;
    /** Top-level entries of the session cwd for `@` file completion. */
    listFiles(): Promise<readonly string[]>;
    /** Recent sessions recorded by the DSH persistence backend (for `/resume`). */
    listSessions(): Promise<readonly SessionRecord[]>;
    /** Mark a session for `dsh-cc --resume` on the next launch. */
    setResumeTarget(sessionId: string): void;
    /** Manually compact the session history (CC's /compact); no-op notify when the leaf lacks a compaction service. */
    compact(): void;
    /** Render a multi-line local report in the transcript (`/status`,
     *  `/doctor`, …): a `local` row plus one `local-output` row per line. */
    pushLocal(title: string, lines: readonly string[]): void;
    /** Write the conversation transcript to `dsh-cc-export-<ts>.md` in the
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
}
/** @internal */
/** One user message submitted while the model was working, not yet claimed
 *  by a turn. `steer` lands at the next step boundary of the running turn;
 *  `followup` waits for the turn to end. */
export interface PendingMessage {
    id: string;
    text: string;
    placement: 'steer' | 'followup';
    /** Released dsh-agent occurrence id (captured from `agent/inbox/enqueue`);
     *  the pull-back key — the released `updateInbox` addresses occurrences,
     *  not message ids. Absent on the dev-trunk agent. */
    inboxItemId?: string;
}
export interface ChannelState {
    version: number;
    rows: ChatRow[];
    status: AgentStatus | 'starting' | 'disposed';
    sessionTitle: string;
    agentId: string;
    model: string;
    tokens: TokenUsage;
    cwd: string;
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
    /** Per-message tps samples (sparkline + μ/p95 readout), oldest first. */
    tpsSamples: {
        tps: number;
        at: number;
    }[];
    /** Latest working-activity snapshot (see the public Channel type). */
    workingActivity: ActivityStatus | undefined;
    /** Working-activity indicator preset (see the public Channel type). */
    activityFrames: string | undefined;
    /** Working-activity consumption switch (see the public Channel type). */
    activityEnabled: boolean;
    /** Current same-session goal projection (see the public Channel type). */
    goal: ChannelGoal | undefined;
    /** Latest todo-list snapshot (see the public Channel type). */
    todos: TodoPanelItem[];
    /** Loaded-context snapshot (see the public Channel type). */
    loadedContext: LoadedContext | undefined;
    /** Messages submitted while working, awaiting their turn/step boundary.
     *  Driven by agent inbox events (inserted/claimed/discarded). */
    pending: PendingMessage[];
    /** Effective slash commands (see the public Channel type). */
    commandList: readonly LocalCommand[];
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
    /** Switch the live model (`/model` picker). */
    switchModel(model: string): Promise<boolean>;
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
    listFiles(): Promise<readonly string[]>;
    listSessions(): Promise<readonly SessionRecord[]>;
    setResumeTarget(sessionId: string): void;
    /** Manually compact the session history (CC's /compact). */
    compact(): void;
    /** Multi-line local report (`/status`, `/doctor`, …). */
    pushLocal(title: string, lines: readonly string[]): void;
    /** Export the transcript to a markdown file (CC's /export). */
    exportSession(): string | null;
    /** Create `AGENTS.md` in the session cwd (CC's /init). */
    initWorkspace(): string | null;
    /** Environment diagnostics (CC's /doctor). */
    doctorInfo(): string[];
    /** Subagent rows (CC's /agents). */
    listSubagents(): Promise<string[]>;
}
/** @internal */
export declare function createChannel(ctx: Context, initialAgent: Agent, options: {
    model: string;
    cwd: string;
    provider: string;
    /** Configured reasoning effort, shown from startup until the first
     *  request/header event reports the adapter's live value. */
    effort?: string;
    /** Consume `activity/status` session events (dsh-working-activity) into
     *  the status line; default on. */
    activity?: boolean;
    /** Indicator preset for the working-activity line (`claude`/`moon`/
     *  `comet`/`dots`/… or `random`); default `claude`. */
    activityFrames?: string;
    /** Handle of the initial agent; disposed when a rewind replaces it. */
    handle?: AgentHandle;
}): ChannelState;
//# sourceMappingURL=channel.d.ts.map