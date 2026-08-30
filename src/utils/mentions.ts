/**
 * `@` file-mention parsing (issue #15).
 *
 * A mention is an `@` that starts a whitespace-delimited token (string start
 * or after whitespace) — `hello@world` never triggers. The token body is
 * either a run of non-whitespace characters (`@src/a.ts`) or a double-quoted
 * path (`@"my dir/a.ts"`, for paths containing spaces).
 *
 * A token may carry a trailing line-range suffix (issue #359, Claude Code
 * parity): `@src/a.ts#L12` / `@src/a.ts#L12-14` (also after a quoted body:
 * `@"my dir/a.ts"#L3-5`). The suffix must anchor at the token END and match
 * `#L<digits>` / `#L<digits>-<digits>` exactly, so legal filenames that merely
 * contain `#` (`report#L12.md`) never trip it; a range like `#L14-12` is
 * rejected (kept as a literal path). Resolution order is strip-first: the
 * suffix-stripped `path` is tried, and the caller may fall back to `literal`
 * (the typed body, suffix intact) when that misses.
 */

export interface MentionToken {
  /** Start index of the `@` in the source text. */
  start: number
  /** End index (exclusive) of the whole token, quote and suffix included. */
  end: number
  /** The referenced path as typed (unquoted, no leading `@`, suffix stripped). */
  path: string
  /** Present only when a line suffix was stripped: the typed body verbatim
   * (unquoted, suffix intact) — the literal fallback path for resolution. */
  literal?: string
  /** Inclusive 1-based first line of the `#L` suffix, when present. */
  startLine?: number
  /** Inclusive 1-based last line of the `#L` suffix; equals `startLine`
   * for the single-line form. */
  endLine?: number
}

/** True when `ch` delimits a token (whitespace). Path separators and the
 *  quote char are ordinary token characters on every platform — Windows
 *  backslash paths must survive both caret tracking and submission. */
const isBoundary = (ch: string | undefined): boolean =>
  ch === undefined || /\s/.test(ch)

/** Line-suffix shape: `#L7` or `#L7-9`, anchored at the token end. */
const LINE_SUFFIX = /#L(\d+)(?:-(\d+))?$/

interface LineRange {
  path: string
  literal: string
  startLine: number
  endLine: number
}

/**
 * Split a trailing `#L7` / `#L7-9` suffix off an unquoted token body.
 * Returns undefined when there is no suffix or the suffix is malformed
 * (`#L0`, `#L9-7`, bare `#L12` with an empty path) — the caller then treats
 * the body as a plain literal path, exactly as before issue #359.
 */
function splitLineSuffix(raw: string): LineRange | undefined {
  const match = LINE_SUFFIX.exec(raw)
  if (match === null) return undefined
  const path = raw.slice(0, match.index)
  if (path === '') return undefined
  const startLine = Number(match[1])
  const endLine = match[2] === undefined ? startLine : Number(match[2])
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return undefined
  if (startLine < 1 || endLine < startLine) return undefined
  return { path, literal: raw, startLine, endLine }
}

/** Extract every `@` mention in `text` (typed order, duplicates kept out). */
export function extractMentions(text: string): MentionToken[] {
  const tokens: MentionToken[] = []
  const seen = new Set<string>()
  let index = 0
  while (index < text.length) {
    const at = text.indexOf('@', index)
    if (at === -1) break
    index = at + 1
    if (!isBoundary(text[at - 1])) continue // email-style `a@b`, mid-token
    if (text[at + 1] === '"') {
      const close = text.indexOf('"', at + 2)
      if (close === -1) continue // unterminated quote — not a mention
      const quoted = text.slice(at + 2, close)
      // `#L` suffix may follow the closing quote and extends the token.
      let end = close + 1
      let range: LineRange | undefined
      if (quoted !== '' && text[close + 1] === '#') {
        let suffixEnd = close + 1
        while (suffixEnd < text.length && !isBoundary(text[suffixEnd])) suffixEnd++
        // splitLineSuffix expects `path + suffix`; feeding it the quoted body
        // plus the tail yields path === quoted and the typed literal.
        range = splitLineSuffix(quoted + text.slice(close + 1, suffixEnd))
        if (range !== undefined) end = suffixEnd
      }
      const key = text.slice(at, end)
      if (quoted !== '' && !seen.has(key)) {
        seen.add(key)
        tokens.push(range === undefined
          ? { start: at, end, path: quoted }
          : { start: at, end, path: quoted, literal: `${quoted}${text.slice(close + 1, end)}`, startLine: range.startLine, endLine: range.endLine })
      }
      index = end
      continue
    }
    let end = at + 1
    while (end < text.length && !isBoundary(text[end])) end++
    const raw = text.slice(at + 1, end)
    // A bare `@` or another trigger char (`@@`) carries no path.
    if (raw && !raw.startsWith('@') && !seen.has(raw)) {
      seen.add(raw)
      const range = splitLineSuffix(raw)
      tokens.push(range === undefined
        ? { start: at, end, path: raw }
        : { start: at, end, path: range.path, literal: range.literal, startLine: range.startLine, endLine: range.endLine })
    }
  }
  return tokens
}

/**
 * The mention token the caret is currently editing, if any: an `@` token
 * that starts at or before the caret with the caret inside it. Used by the
 * prompt's completion trigger so `@` works mid-message, not only at the
 * start of the input.
 *
 * `query` is the PATH portion only (a `#L12-14` suffix never leaks into
 * it) and `pathEnd` marks where that portion ends, so completing a token
 * like `@src/a.ts#L12` matches on `src/a.ts` and replaces up to (not past)
 * the `#` — the typed line range survives acceptance.
 */
export function mentionAtCaret(
  value: string,
  cursor: number,
): { start: number; end: number; query: string; pathEnd?: number } | undefined {
  // Token start: scan back from the caret to the previous boundary.
  let start = cursor
  while (start > 0 && !isBoundary(value[start - 1])) start--
  if (value[start] !== '@') return undefined
  // Quoted form: the caret must sit before the closing quote.
  if (value[start + 1] === '"') {
    const close = value.indexOf('"', start + 2)
    if (close !== -1 && cursor > close) return undefined
    return { start, end: close === -1 ? value.length : close + 1, query: value.slice(start + 2, cursor) }
  }
  // Token end: first boundary at/after the caret.
  let end = cursor
  while (end < value.length && !isBoundary(value[end])) end++
  const queryEnd = Math.min(cursor, end)
  const range = splitLineSuffix(value.slice(start + 1, end))
  const pathEnd = range === undefined ? end : start + 1 + range.path.length
  return { start, end, query: value.slice(start + 1, Math.min(queryEnd, pathEnd)), pathEnd: range === undefined ? undefined : pathEnd }
}
