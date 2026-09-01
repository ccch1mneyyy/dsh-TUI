/**
 * Conservative recognition of "the terminal pasted exactly one local image
 * file path" — the only shape a Finder/desktop drop reliably reaches the TUI
 * as. Ghostty (and most terminals) forward a drop as shell-escaped plain
 * text through the PTY, with no MIME or drag-and-drop boundary, so anything
 * ambiguous must stay verbatim text: this parser returns null unless the
 * WHOLE paste is a single, syntactically unambiguous local image path.
 * Existence is the caller's async check; parse success alone stages nothing.
 */

import { homedir } from 'node:os'

/** Image media type per file extension, or undefined for non-image paths.
 *  The one extension→type table shared by every composer staging path. */
export function imagePathMediaType(
  path: string,
): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (/\.png$/iu.test(path)) return 'image/png'
  if (/\.jpe?g$/iu.test(path)) return 'image/jpeg'
  if (/\.webp$/iu.test(path)) return 'image/webp'
  if (/\.gif$/iu.test(path)) return 'image/gif'
  return undefined
}

const MAX_PASTED_PATH_CHARS = 4096

/**
 * Parse a bracketed-paste payload as one unambiguous local image path.
 *
 * Accepted forms (after trimming outer whitespace):
 * - a wholly single- or double-quoted path: `'/a/b c.png'`, `"/a/b c.png"`
 * - one bare token with backslash-escaped separators (Ghostty's
 *   `Shell.escape`): `/a/b\ c.png`
 *
 * The decoded path must be absolute (or `~/…`, expanded) and carry a
 * supported image extension. Everything else — multiple tokens, relative
 * paths, embedded newlines, unterminated quotes, non-image extensions —
 * returns null so the caller inserts the paste verbatim.
 */
export function parsePastedImagePath(text: string): string | null {
  if (text.length > MAX_PASTED_PATH_CHARS) return null
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.includes('\n') || trimmed.includes('\r')) return null

  let path: string | null
  const quote = trimmed[0]
  if (quote === "'" || quote === '"') {
    if (trimmed.length < 3 || !trimmed.endsWith(quote)) return null
    const inner = trimmed.slice(1, -1)
    // A quote of the same kind inside means this was not one quoted token.
    if (inner.includes(quote)) return null
    path = quote === '"' ? unescapeBackslashes(inner) : inner
  } else {
    path = unescapeBackslashes(trimmed, { failOnBareWhitespace: true })
  }
  if (path === null) return null

  if (path.startsWith('~/')) path = homedir() + path.slice(1)
  if (!path.startsWith('/')) return null
  if (imagePathMediaType(path) === undefined) return null
  return path
}

/** Resolve `\x` escapes with one linear scan. With `failOnBareWhitespace`,
 *  an unescaped space/tab (multiple shell tokens) or a dangling trailing
 *  backslash makes the whole parse fail. */
function unescapeBackslashes(
  text: string,
  options: { failOnBareWhitespace?: boolean } = {},
): string | null {
  let out = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === '\\') {
      if (index + 1 >= text.length) return null
      out += text[index + 1]!
      index += 1
      continue
    }
    if (options.failOnBareWhitespace === true && (char === ' ' || char === '\t')) {
      return null
    }
    out += char
  }
  return out
}

/**
 * Partition a file-manager clipboard offer: image paths stage into composer
 * tokens through `stage`, other or failed paths keep `formatPath`'s plain
 * insert, preserving offer order. `failure` carries the last staging error
 * message ('' when none) so the caller can surface one warning.
 */
export async function stageClipboardFilePaths(
  paths: readonly string[],
  stage: (path: string) => Promise<string>,
  formatPath: (path: string) => string,
): Promise<{
  readonly parts: readonly string[]
  readonly staged: readonly string[]
  readonly failure: string
}> {
  const parts: string[] = []
  const staged: string[] = []
  let failure = ''
  for (const path of paths) {
    if (imagePathMediaType(path) === undefined) {
      parts.push(formatPath(path))
      continue
    }
    try {
      const token = await stage(path)
      parts.push(token)
      staged.push(token)
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error)
      parts.push(formatPath(path))
    }
  }
  return { parts, staged, failure }
}
