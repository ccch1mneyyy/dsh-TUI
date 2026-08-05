import type { Agent, AgentHandle, AgentStatus } from '@deepseek-ai/dsh-agent';
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
    /** Full arguments, shown when Ctrl+O verbose mode is on. */
    readonly argsFull: string;
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
    kind: 'user' | 'assistant' | 'tool' | 'notice' | 'reasoning' | 'interrupt' | 'local' | 'local-output';
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
    /** Source session event seq (user rows) — the rewind fork anchor. */
    seq?: number;
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
    subscribe(listener: () => void): () => void;
    submit(text: string): void;
    /** Abort the in-flight turn (`Ctrl+C` while working). */
    cancel(): void;
    /** Rewind the conversation to a past user message (CC's double-Esc rewind):
     *  forks the session through that message, swaps in a fresh agent, and
     *  returns the message text for re-editing — or `null` when unwritable. */
    rewindTo(row: ChatRow): Promise<string | null>;
    /** Switch the live agent to a persisted session, replaying its history. */
    resumeTo(sessionId: string): Promise<boolean>;
    /** Reset the visible transcript (`/clear`). */
    clear(): void;
    /** Push a transient notification above the prompt input. */
    notify(text: string, options?: {
        color?: NotificationItem['color'];
        timeoutMs?: number;
    }): void;
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
}
/** @internal */
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
    subscribe(listener: () => void): () => void;
    /** @internal event bump (the public `notify(text)` posts a notification). */
    emit(): void;
    submit(text: string): void;
    cancel(): void;
    rewindTo(row: ChatRow): Promise<string | null>;
    /** Switch the live agent to a persisted session, replaying its history. */
    resumeTo(sessionId: string): Promise<boolean>;
    clear(): void;
    notify(text: string, options?: {
        color?: NotificationItem['color'];
        timeoutMs?: number;
    }): void;
    listModels(): Promise<readonly LlmModelInfo[]>;
    listFiles(): Promise<readonly string[]>;
    listSessions(): Promise<readonly SessionRecord[]>;
    setResumeTarget(sessionId: string): void;
    /** Manually compact the session history (CC's /compact). */
    compact(): void;
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