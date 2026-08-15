/**
 * Side Question (`/btw`) — CC's btw.tsx/sideQuestion.ts semantics on the
 * dsh call primitives: a single-turn, TOOL-LESS LLM call replaying the
 * live session's derived history (prompt-cache reuse, compaction-style
 * auxiliary call) plus one wrapped user message. The answer never enters
 * the session log — it is pure UI state in the Chat screen.
 *
 * @module
 */

import { BlockAssembler, type StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * Wrap a side question with the single-response, no-tools contract (CC's
 * wording): a lightweight instance sharing the conversation context, the
 * main agent uninterrupted, no promises of action, no looking things up.
 */
export function wrapSideQuestion(question: string): string {
  return `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>

${question}`
}

/** Outcome of one side question: the visible text answer, or an error. */
export interface SideQuestionOutcome {
  answer: string | null
  error?: string
}

/**
 * Run one side-question call: stream the assembled options, fold chunks
 * through the shared BlockAssembler, and surface the assembled text
 * blocks as the answer. `onText` receives visible text deltas only
 * (reasoning deltas are ignored — a side question wants the quick answer).
 */
export async function runSideQuestion(params: {
  /** `ctx.llm.stream` (bound); the options below pass through verbatim. */
  stream: (options: object) => AsyncIterable<StreamChunk>
  /** Assembled GenerateOptions — no `tools` field, ever. */
  options: object
  /** Streaming display hook (text deltas only). */
  onText?: (delta: string) => void
  /** Cancellation: aborting yields `{answer: null}` with no error text. */
  signal?: AbortSignal
}): Promise<SideQuestionOutcome> {
  const { stream, options, onText, signal } = params
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of stream(options)) {
      assembler.push(chunk)
      if (chunk.type === 'text-delta' && chunk.text) onText?.(chunk.text)
    }
  } catch (error) {
    if (signal?.aborted) return { answer: null }
    return { answer: null, error: error instanceof Error ? error.message : String(error) }
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return { answer: null, error: finish.failure.message }
  }
  const answer = assembler.blocks()
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (answer === '') return { answer: null, error: 'No response received' }
  return { answer }
}
