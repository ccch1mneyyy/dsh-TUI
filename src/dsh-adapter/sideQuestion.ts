/**
 * Side Question (`/btw`): a single-turn call without tools, replaying the
 * live session's derived history (prompt-cache reuse, compaction-style
 * auxiliary call) plus one wrapped user message. The answer never enters
 * the session log — it is pure UI state in the Chat screen.
 *
 * @module
 */

import { BlockAssembler, type StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * Describe the auxiliary call's scope: one answer from existing context,
 * with no tools, follow-up actions, or interruption of the main session.
 */
export function wrapSideQuestion(question: string): string {
  return `<side-question-context>
Give one concise answer to the question below using the conversation already provided.
This auxiliary call runs alongside the main session. The main task continues independently;
do not describe it as interrupted, resumed, or as work performed by this call.
No tools are available here: do not claim to inspect files, execute commands, browse,
or carry out future actions. There will be no follow-up turn for this call.
When the available context is insufficient, state what is unknown without promising research.
</side-question-context>

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
