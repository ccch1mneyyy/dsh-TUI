/**
 * Backend-neutral token accounting helpers for the shared projector. Pricing
 * policy (which rate window a request ran in, what a token costs) is NOT here:
 * the projector receives the window as an injected `pricingWindow` and only
 * buckets counts; pricing tables stay with their backend.
 */
import type { CostTokenBuckets, TokenBucket, TokenUsage } from '../adapter/ports/channel-view.js'
import type { UsageDelta } from '../agent/events.js'

/** Rate window a usage is bucketed under (`peak`/`idle` price separately). */
export type PricingWindow = 'peak' | 'idle'

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

/** Empty peak/idle buckets for one model's cost accumulation. */
export function emptyCostBuckets(): CostTokenBuckets {
  return {
    peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/** Add one usage to the bucket of its rate window (in place). */
export function addUsageToBucket(bucket: TokenBucket, usage: UsageDelta): void {
  bucket.input += usage.input ?? 0
  bucket.output += usage.output ?? 0
  bucket.cacheRead += usage.cacheRead ?? 0
  bucket.cacheWrite += usage.cacheWrite ?? 0
}

/** Context-bar token estimate (pi-nano-context: ~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Reported output count when usable; durable imports may predate strict validation. */
export function usageOutputTokens(usage: UsageDelta | undefined): number | undefined {
  const value: unknown = usage?.output
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}
