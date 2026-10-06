/**
 * Token usage and rate limits (docs/codex-backend-design.md §7.5).
 *
 * `thread/tokenUsage/updated` reports `last` (the latest model call) and
 * `total`. OpenAI counts cached and cache-written prompt tokens inside
 * `inputTokens`; the shared vocabulary keeps them apart (occupancy is
 * input + cacheRead + cacheWrite), so the uncached share is what remains.
 */
import type { RateLimitView, UsageDelta } from '../../../agent/events.js'
import { num, rec, type Rec } from '../narrow.js'

/** One `TokenUsageBreakdown` in the shared vocabulary. */
export function usageOf(breakdown: unknown): UsageDelta | undefined {
  const value = rec(breakdown)
  if (value === undefined) return undefined
  const input = num(value.inputTokens)
  const output = num(value.outputTokens)
  if (input === undefined && output === undefined) return undefined
  const cacheRead = num(value.cachedInputTokens) ?? 0
  const cacheWrite = num(value.cacheWriteInputTokens) ?? 0
  return {
    input: Math.max(0, (input ?? 0) - cacheRead - cacheWrite),
    output: output ?? 0,
    cacheRead,
    cacheWrite,
  }
}

/** Sum two usages (absent counts stay absent only when both are). */
export function addUsage(a: UsageDelta | undefined, b: UsageDelta | undefined): UsageDelta | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return {
    input: (a.input ?? 0) + (b.input ?? 0),
    output: (a.output ?? 0) + (b.output ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
  }
}

/** A `thread/tokenUsage/updated` payload: the latest call and the window. */
export function tokenUsageOf(params: Rec): { readonly last?: UsageDelta; readonly window?: number } {
  const usage = rec(params.tokenUsage)
  const last = usageOf(usage?.last)
  const window = num(usage?.modelContextWindow)
  return { ...(last === undefined ? {} : { last }), ...(window === undefined || window <= 0 ? {} : { window }) }
}

/** The status line's window name for a window length (5 h / 7 d keep the
 *  names the status line localizes; anything else reads as minutes). */
export function windowName(minutes: number | undefined): string {
  if (minutes === 300) return 'five_hour'
  if (minutes === 10_080) return 'seven_day'
  if (minutes === undefined) return 'window'
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
}

/** `account/rateLimits/updated` → the shared view; undefined when the
 *  snapshot carries no window (a relay reports none). */
export function rateLimitOf(params: Rec): { readonly view?: RateLimitView; readonly reached?: string } {
  const snapshot = rec(params.rateLimits)
  const windows = [snapshot?.primary, snapshot?.secondary].flatMap(raw => {
    const window = rec(raw)
    const used = num(window?.usedPercent)
    if (window === undefined || used === undefined) return []
    const resetsAt = num(window.resetsAt)
    return [{ name: windowName(num(window.windowDurationMins)), utilization: used / 100, ...(resetsAt === undefined ? {} : { resetsAt: resetsAt * 1000 }) }]
  })
  const reached = typeof snapshot?.rateLimitReachedType === 'string' ? snapshot.rateLimitReachedType : undefined
  return { ...(windows.length === 0 ? {} : { view: { windows } }), ...(reached === undefined ? {} : { reached }) }
}
