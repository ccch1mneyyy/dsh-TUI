import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 0.1.7 puts tool output on the message; older logs wrap it in one block. */
export function toolResultPayload(message: {
  readonly content?: readonly ContentBlock[]
  readonly isError?: boolean
} | undefined): { content: readonly ContentBlock[]; isError: boolean } {
  const first = message?.content?.[0] as {
    type?: string
    content?: readonly ContentBlock[]
    isError?: boolean
  } | undefined
  if (first?.type === 'tool-result') {
    return {
      content: Array.isArray(first.content) ? first.content : [],
      isError: first.isError === true,
    }
  }
  return { content: message?.content ?? [], isError: message?.isError === true }
}

/** Preserve old checkpoints while recognizing the V4 producer-owned source. */
export function isCompactionCheckpointSource(source: { kind: string; plugin?: string }): boolean {
  return source.kind === 'compact-checkpoint' || (source.kind === 'plugin' && source.plugin === 'compact')
}
