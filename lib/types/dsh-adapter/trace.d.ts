/**
 * `/trace` trajectory view — data assembly (issue #80). Pure functions over
 * the DSH session event log (`SessionEvent[]`, each event carrying a
 * monotonic `seq` and epoch-ms `time`): the log is folded into a flat list
 * of one-line trace entries — one per user/assistant/thinking/todo item,
 * one per turn/step/tool bracket, with the bracket's duration filled in when
 * its closing event arrives (`tool/call` ↔ `tool/result` by callId,
 * `step/start` ↔ `step/end` and `turn/start` ↔ `turn/end` by index).
 *
 * The UI consumes {@link extendTrace}: `agent.session.events` is an
 * immutable snapshot that is REUSED until the next append (dsh-session
 * caches the frozen array), so the previous build is kept and only the new
 * tail is consumed — a long session never pays an O(log) rebuild per frame.
 * {@link buildTraceEntries} is the from-scratch form for tests and one-shot
 * consumers.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** The entry kinds a trace row can carry. */
export type TraceKind = 'turn' | 'step' | 'user' | 'assistant' | 'thinking' | 'tool' | 'todo';
/** One line of the trajectory timeline. */
export interface TraceEntry {
    /** Seq of the event the entry was built from (turn/step/tool: the opener). */
    readonly seq: number;
    /** Epoch-ms timestamp of that event. */
    readonly time: number;
    readonly kind: TraceKind;
    /** One-line summary (whitespace flattened, char-capped; the view applies
     *  the final display-width truncation). */
    readonly summary: string;
    /** Paired wall-clock duration, filled when the closing event lands. */
    durationMs?: number;
    /** Bracket status: open brackets stay `running` until closed. */
    status?: 'running' | 'ok' | 'error';
}
/** The type filters the view cycles through (`f` key). */
export type TraceFilter = 'all' | 'tool' | 'thinking' | 'message' | 'progress';
/** Filter cycle order (the `f` key walks this list). */
export declare const TRACE_FILTERS: readonly TraceFilter[];
/**
 * One in-progress assembly: the flat entry list plus the open-bracket
 * indexes that pair closers with their opener entries. Kept across appends
 * by {@link extendTrace} so only the new tail is consumed.
 */
export interface TraceBuild {
    /** The event snapshot this build consumed (identity-compared per append). */
    readonly source: readonly SessionEvent[];
    readonly entries: TraceEntry[];
    /** Open tool calls by callId (tool/call → its entry until tool/result). */
    readonly tools: ReadonlyMap<string, TraceEntry>;
    /** Open steps by `turn:step` (step/start → its entry until step/end). */
    readonly steps: ReadonlyMap<string, TraceEntry>;
    /** Open turns by turn number (turn/start → its entry until turn/end). */
    readonly turns: ReadonlyMap<number, TraceEntry>;
}
/**
 * Assemble the trace from scratch (tests, one-shot consumers). Live UI uses
 * {@link extendTrace} to reuse the previous build across appends.
 */
export declare function buildTraceEntries(events: readonly SessionEvent[]): TraceEntry[];
/**
 * Extend a previous build with the session's current event snapshot. The
 * snapshot is append-only with stable event object identity (dsh-session
 * freezes each event at append), so a snapshot that prefix-extends the
 * previous one only consumes the new tail; anything else (agent swap on
 * /resume /rewind /new) triggers a full rebuild.
 */
export declare function extendTrace(prev: TraceBuild | null, events: readonly SessionEvent[]): TraceBuild;
/** Apply a type filter (the `f` key cycles {@link TRACE_FILTERS}). */
export declare function filterTraceEntries(entries: readonly TraceEntry[], filter: TraceFilter): readonly TraceEntry[];
/** `HH:MM:SS` wall-clock of an event timestamp (local time, zero-padded). */
export declare function formatClock(time: number): string;
/** Compact paired duration: `350ms` / `1.5s` / `2m05s`. */
export declare function formatDuration(ms: number): string;
/**
 * Truncate a plain (no-ANSI) string to a terminal display width, CJK-aware
 * (wide chars count 2 via the ink core's stringWidth). Appends `…` when cut.
 */
export declare function truncateWidth(text: string, maxWidth: number): string;
//# sourceMappingURL=trace.d.ts.map