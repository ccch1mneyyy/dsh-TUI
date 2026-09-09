import {
  type StreamChunk
} from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from './types.js'

/** 全零 token 累计（新会话 / 复位用）。 */
export function emptyTokenUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/** Context-bar token estimate (pi-nano-context: ~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Whether one stream chunk advances the first-token/decode boundary. */
export function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/** Character payload of one token-bearing stream delta for the live fallback. */
export function tokenDeltaChars(chunk: StreamChunk): number {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text.length
    case 'tool-call-delta':
      return (chunk.name?.length ?? 0) + chunk.argumentsDelta.length
    default:
      return 0
  }
}

/** Provider output count when usable; durable imports may predate strict validation. */
export function usageOutputTokens(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const value = (usage as { outputTokens?: unknown }).outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}
