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

/** Tool-call ids one message answers: 0.1.7 tool-role messages, or older result blocks. */
export function answeredToolCallIds(message: {
  readonly role: string
  readonly toolCallId?: string
  readonly content: readonly ContentBlock[]
}): string[] {
  const ids = message.role === 'tool' && typeof message.toolCallId === 'string' ? [message.toolCallId] : []
  for (const block of message.content as readonly { type?: string; toolCallId?: unknown }[]) {
    if (block.type === 'tool-result' && typeof block.toolCallId === 'string') ids.push(block.toolCallId)
  }
  return ids
}

/** Preserve old checkpoints while recognizing the V4 producer-owned source. */
export function isCompactionCheckpointSource(source: { kind: string; plugin?: string }): boolean {
  return source.kind === 'compact-checkpoint' || (source.kind === 'plugin' && source.plugin === 'compact')
}
