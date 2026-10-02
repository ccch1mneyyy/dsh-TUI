import { getWordSegmenter } from './intl.js'

/**
 * Word boundaries for the prompt draft. `Intl.Segmenter` (`granularity:
 * 'word'`, UAX #29 + the ICU dictionary) is the source of truth; a cheap
 * hard-rule layer in front of it answers the common cases (edges, whitespace,
 * CJK punctuation, script changes) without paying for a segmentation.
 *
 * Two callers:
 *
 * - `Ctrl+Z`/typing grouping asks whether a seam (`text[offset-1] |
 *   text[offset]`) is a word boundary — {@link isDraftWordBoundary}.
 * - a deletion run asks for the word interval its first removed character
 *   belongs to, so the run may keep consuming that word and nothing else —
 *   {@link draftWordRangeAt}.
 *
 * Idle coalescing is deliberately NOT here: the undo stack applies its own
 * 700ms rule so a test clock can be injected at that call site.
 */

/** Window radius (characters) for the ICU layer, and its scan budget. */
const DRAFT_WORD_WINDOW = 32

const WHITESPACE = /\s/u
const HAN = /\p{Script=Han}/u
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const HANGUL = /\p{Script=Hangul}/u
const LATIN = /\p{Script=Latin}/u
const DIGIT = /\p{N}/u
/**
 * CJK/fullwidth punctuation always severs a word: ，。！？、；：""''（）《》【】
 * plus the rest of the CJK Symbols, Halfwidth/Fullwidth Forms and the
 * curly-quote/ellipsis/em-dash block.
 */
const CJK_PUNCT =
  /[\u2014\u2018\u2019\u201c\u201d\u2026\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u
/** Grapheme-cluster continuations: combining marks, ZWJ, variation selectors. */
const JOINER = /[\p{M}\u200d\ufe00-\ufe0f]/u

const CLASS_OTHER = 0
const CLASS_LATIN = 1
const CLASS_DIGIT = 2
const CLASS_HAN = 3
const CLASS_KANA = 4
const CLASS_HANGUL = 5

/** Code point ending at `index`, surrogate-pair aware. */
function codePointBefore(text: string, index: number): number {
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) {
      return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
    }
  }
  return low
}

function scriptClass(codePoint: number): number {
  const char = String.fromCodePoint(codePoint)
  if (HAN.test(char)) return CLASS_HAN
  if (KANA.test(char)) return CLASS_KANA
  if (HANGUL.test(char)) return CLASS_HANGUL
  if (DIGIT.test(char)) return CLASS_DIGIT
  if (LATIN.test(char)) return CLASS_LATIN
  return CLASS_OTHER
}

/** Continuation of a grapheme cluster: combining mark, ZWJ, variation selector. */
function isClusterJoiner(codePoint: number): boolean {
  return JOINER.test(String.fromCodePoint(codePoint))
}

/**
 * Script class of the character before `offset`, skipping any trailing
 * cluster joiners so `e` + U+0301 classifies as Latin, not "other".
 */
function leftClassAt(text: string, offset: number): number {
  let index = offset
  while (index > 0) {
    const codePoint = codePointBefore(text, index)
    if (!isClusterJoiner(codePoint)) return scriptClass(codePoint)
    index = stepBackward(text, index)
  }
  return CLASS_OTHER
}

/** Layer 1 only: cheap, context-free break rules (edges count as breaks). */
function hardBoundaryAt(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true
  const right = text.codePointAt(offset)!
  // A joining mark on the right means the seam sits INSIDE a grapheme
  // cluster — never a word boundary, whatever the base character's class.
  if (isClusterJoiner(right)) return false
  const left = codePointBefore(text, offset)
  const leftChar = String.fromCodePoint(left)
  const rightChar = String.fromCodePoint(right)
  if (WHITESPACE.test(leftChar) || WHITESPACE.test(rightChar)) return true
  if (CJK_PUNCT.test(leftChar) || CJK_PUNCT.test(rightChar)) return true
  return leftClassAt(text, offset) !== scriptClass(right)
}

/** Previous code-point index before `index` (never splits a surrogate pair). */
function stepBackward(text: string, index: number): number {
  const codePoint = codePointBefore(text, index)
  return codePoint > 0xffff ? index - 2 : index - 1
}

/**
 * Whether the seam at `offset` (`text[offset-1] | text[offset]`) is a word
 * boundary. `offset` is a code-unit index, as produced by the composer's
 * grapheme-normalized caret.
 */
export function isDraftWordBoundary(text: string, offset: number): boolean {
  if (hardBoundaryAt(text, offset)) return true
  // Layer 1 rejected this offset, so 0 < offset < text.length, which means the
  // window's own edges can never masquerade as a seam boundary and the queried
  // offset is always strictly inside.
  const start = Math.max(0, offset - DRAFT_WORD_WINDOW)
  const end = Math.min(text.length, offset + DRAFT_WORD_WINDOW)
  for (const part of getWordSegmenter().segment(text.slice(start, end))) {
    if (start + part.index === offset) return true
  }
  return false
}

/**
 * The word interval `[start, end)` containing the character at `index`: the
 * ICU segment when that character is word-like, otherwise just the character
 * itself (whitespace and punctuation are boundaries, never part of a
 * multi-character word). A deletion run uses this as the range it may keep
 * consuming.
 *
 * The window widens until the segment no longer touches its edge: ICU
 * segmentation is length-dependent, so a truncated copy of a repeated-Han run
 * can split differently from the full draft (and the ±32 window would then
 * read the wrong word at the seam).
 */
export function draftWordRangeAt(text: string, index: number): { start: number; end: number } {
  const single = { start: index, end: index + 1 }
  if (index < 0 || index >= text.length) return single
  const segmenter = getWordSegmenter()
  let radius = DRAFT_WORD_WINDOW
  for (;;) {
    const windowStart = Math.max(0, index - radius)
    const windowEnd = Math.min(text.length, index + radius)
    for (const part of segmenter.segment(text.slice(windowStart, windowEnd))) {
      const start = windowStart + part.index
      const end = start + part.segment.length
      if (start > index || index >= end) continue
      const clipped =
        (start === windowStart && windowStart > 0) || (end === windowEnd && windowEnd < text.length)
      if (!clipped) return part.isWordLike === true ? { start, end } : single
      break
    }
    if (windowStart === 0 && windowEnd === text.length) return single
    radius = Math.min(radius * 2, text.length)
  }
}
