import {
  type StreamChunk
} from '@deepseek-ai/dsh-llm'
import { emptyTokenUsage, estimateTokens } from '../../channel/usage.js'

// The neutral helpers live with the shared projector (src/channel/usage.ts);
// re-exported here for the existing importers.
export { emptyTokenUsage, estimateTokens }

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

/** DSH-shaped (`outputTokens`) output count when usable; durable imports may predate strict validation. */
export function usageOutputTokens(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const value = (usage as { outputTokens?: unknown }).outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}
