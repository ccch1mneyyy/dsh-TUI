/**
 * Backend-neutral token accounting helpers for the shared projector. Pricing
 * policy (which rate window a request ran in, what a token costs) is not here:
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

/*
 * Script-class rates for the context bar's local token estimate.
 *
 * pi-nano-context's original `text.length / 4` is an English heuristic: BPE
 * vocabularies pack roughly four ASCII characters into one token, but CJK text
 * runs ~1–1.5 characters per token (one ideograph is one or two tokens), so the
 * English rate under-counted Chinese/Korean/Japanese sessions by ~3x — the
 * segmented bar, its hover breakdown and everything derived from these numbers
 * were squeezed flat against the real occupancy reading (issue #1170).
 *
 * These are ESTIMATES, not metering: no tokenizer is consulted, and the guess
 * cannot see the provider vocabulary, the request envelope (role markers, tool
 * JSON, image blocks) or a cached prefix that the next request will not resend
 * in full. The authoritative occupancy is the backend's own reading (DSH: the
 * harness `contextPressure` projection, `projectedTokens ?? pressureTokens`, see
 * `dsh-adapter/context-occupancy.ts`); these numbers only describe what the
 * segmented bar is made of and must never be summed into that total.
 */

/** ASCII, including control bytes and ANSI escapes: ~4 characters per token. */
const CHARS_PER_TOKEN_ASCII = 4
/** CJK ideographs, kana, Hangul, Bopomofo, Yi, CJK punctuation and full-width
 *  forms: ~1.4 characters per token (the midpoint of the measured 1–1.5 band). */
const CHARS_PER_TOKEN_CJK = 1.4
/** Everything else — accented Latin, Cyrillic, Greek, Arabic, Hebrew, Thai,
 *  Devanagari, emoji — deliberately conservative at 2 characters per token:
 *  denser scripts (Thai, Devanagari) and multi-token emoji clusters still come
 *  out low, while lighter ones are over-counted rather than under-counted. */
const CHARS_PER_TOKEN_OTHER = 2

/** Cheapest possible "does this text need script classification at all" test. */
const NON_ASCII_RE = /[^\x00-\x7f]/

/**
 * Whether one code point belongs to a script BPE vocabularies pack at roughly
 * one token per character or two. Emoji are deliberately excluded (they land in
 * the `OTHER` rate): they are not East Asian wide *text*, and a ZWJ cluster is
 * several code points the tokenizer may charge several tokens for.
 */
function isDenseScript(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) // Hangul Jamo
    || (codePoint >= 0x2e80 && codePoint <= 0x303f) // CJK radicals … CJK symbols and punctuation
    || (codePoint >= 0x3040 && codePoint <= 0x33ff) // kana, Bopomofo, Hangul compat jamo, enclosed/compat CJK
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf) // CJK unified ideographs extension A
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff) // CJK unified ideographs
    || (codePoint >= 0xa000 && codePoint <= 0xa4cf) // Yi syllables and radicals
    || (codePoint >= 0xa960 && codePoint <= 0xa97f) // Hangul Jamo Extended-A
    || (codePoint >= 0xac00 && codePoint <= 0xd7af) // Hangul syllables
    || (codePoint >= 0xd7b0 && codePoint <= 0xd7ff) // Hangul Jamo Extended-B
    || (codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK compatibility ideographs
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f) // CJK compatibility forms
    || (codePoint >= 0xfe50 && codePoint <= 0xfe6f) // small form variants (CJK punctuation variants)
    || (codePoint >= 0xff00 && codePoint <= 0xff60) // full-width forms
    || (codePoint >= 0xff61 && codePoint <= 0xffdc) // half-width kana, half-width Hangul, half-width CJK punctuation
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6) // full-width signs
    || (codePoint >= 0x1f200 && codePoint <= 0x1f2ff) // enclosed ideographic supplement
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK extensions B–G
  )
}

/**
 * Context-bar token estimate for model-visible text: a per-code-point weighted
 * count by script class (see the rates above), rounded up.
 *
 * Pure and deterministic: non-negative, zero only for the empty string, and
 * monotonic — appending characters never lowers the result. A single call on
 * pure ASCII input is exactly `ceil(length / 4)` (there is an explicit fast
 * path). Rounding happens per call, so summing this estimator over messages
 * can differ from rounding the summed characters once by at most one token
 * per call (ASCII-only sums included). ANSI escapes are not stripped: they
 * are ASCII, and the provider tokenizes the literal message bytes rather than
 * the rendered cells.
 *
 * @param text - Model-visible text (a prompt, an assistant block, a tool
 *   result); widths are irrelevant here, this counts characters, not cells.
 * @returns The estimated token count (0 for empty input).
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  // Fast path: ASCII-only text is exactly the legacy rate, and the regex scan
  // keeps the overwhelmingly common English case cheaper than a code-point walk.
  if (!NON_ASCII_RE.test(text)) return Math.ceil(text.length / CHARS_PER_TOKEN_ASCII)
  let ascii = 0
  let dense = 0
  let other = 0
  for (const character of text) {
    // `for…of` walks code points, so a surrogate pair (emoji, CJK extension B+)
    // counts once instead of twice.
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint < 0x80) ascii += 1
    else if (isDenseScript(codePoint)) dense += 1
    else other += 1
  }
  return Math.ceil(
    ascii / CHARS_PER_TOKEN_ASCII
    + dense / CHARS_PER_TOKEN_CJK
    + other / CHARS_PER_TOKEN_OTHER,
  )
}

/** Reported output count when usable; durable imports may predate strict validation. */
export function usageOutputTokens(usage: UsageDelta | undefined): number | undefined {
  const value: unknown = usage?.output
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}
