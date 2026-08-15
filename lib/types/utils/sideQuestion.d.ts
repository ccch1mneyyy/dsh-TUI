/**
 * Side Question (`/btw`) — CC's btw.tsx/sideQuestion.ts semantics on the
 * dsh call primitives: a single-turn, TOOL-LESS LLM call replaying the
 * live session's derived history (prompt-cache reuse, compaction-style
 * auxiliary call) plus one wrapped user message. The answer never enters
 * the session log — it is pure UI state in the Chat screen.
 *
 * @module
 */
import { type StreamChunk } from '@deepseek-ai/dsh-llm';
/**
 * Wrap a side question with the single-response, no-tools contract (CC's
 * wording): a lightweight instance sharing the conversation context, the
 * main agent uninterrupted, no promises of action, no looking things up.
 */
export declare function wrapSideQuestion(question: string): string;
/** Outcome of one side question: the visible text answer, or an error. */
export interface SideQuestionOutcome {
    answer: string | null;
    error?: string;
}
/**
 * Run one side-question call: stream the assembled options, fold chunks
 * through the shared BlockAssembler, and surface the assembled text
 * blocks as the answer. `onText` receives visible text deltas only
 * (reasoning deltas are ignored — a side question wants the quick answer).
 */
export declare function runSideQuestion(params: {
    /** `ctx.llm.stream` (bound); the options below pass through verbatim. */
    stream: (options: object) => AsyncIterable<StreamChunk>;
    /** Assembled GenerateOptions — no `tools` field, ever. */
    options: object;
    /** Streaming display hook (text deltas only). */
    onText?: (delta: string) => void;
    /** Cancellation: aborting yields `{answer: null}` with no error text. */
    signal?: AbortSignal;
}): Promise<SideQuestionOutcome>;
//# sourceMappingURL=sideQuestion.d.ts.map