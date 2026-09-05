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
    if (quote === "'") {
      // POSIX single quotes are wholly literal and cannot contain one.
      if (inner.includes(quote)) return null
      path = inner
    } else {
      path = unescapeDoubleQuoted(inner)
    }
  } else {
    path = unescapeBackslashes(trimmed)
  }
  if (path === null) return null

  if (path.startsWith('~/')) path = homedir() + path.slice(1)
  if (!path.startsWith('/')) return null
  if (imagePathMediaType(path) === undefined) return null
  return path
}

/** Decode only the two unambiguous escapes inside a shell double-quoted
 * token. Treating every `\x` as x can silently redirect a pasted path to a
 * different existing file, so unknown escapes and naked quotes fail closed. */
function unescapeDoubleQuoted(text: string): string | null {
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (char === '"') return null
    if (char !== '\\') {
      out += char
      continue
    }
    if (index + 1 >= text.length) return null
    const escaped = text[index + 1]!
    if (escaped !== '\\' && escaped !== '"') return null
    out += escaped
    index += 1
  }
  return out
}

/** Resolve `\x` escapes with one linear scan. An unescaped space/tab
 *  (multiple shell tokens) or a dangling trailing backslash fails. */
function unescapeBackslashes(text: string): string | null {
  let out = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === '\\') {
      if (index + 1 >= text.length) return null
      out += text[index + 1]!
      index += 1
      continue
    }
    if (char === ' ' || char === '\t') {
      return null
    }
    out += char
  }
  return out
}

/**
 * Partition a file-manager clipboard offer: image paths resolve to opaque
 * staged values through `stage`, while other or failed paths keep
 * `formatPath`'s plain insert, preserving offer order. The caller binds all
 * staged values to visible tokens only after this batch settles. `failure`
 * carries the last staging error message ('' when none) for one warning.
 */
export type StagedClipboardFilePart<T> =
  | { readonly kind: 'staged'; readonly value: T }
  | { readonly kind: 'text'; readonly value: string }

export async function stageClipboardFilePaths<T>(
  paths: readonly string[],
  stage: (path: string) => Promise<T>,
  formatPath: (path: string) => string,
  maxStaged = Number.POSITIVE_INFINITY,
): Promise<{
  readonly parts: readonly StagedClipboardFilePart<T>[]
  readonly staged: readonly T[]
  readonly failure: string
}> {
  const parts: StagedClipboardFilePart<T>[] = []
  const staged: T[] = []
  let failure = ''
  for (const path of paths) {
    if (imagePathMediaType(path) === undefined) {
      parts.push({ kind: 'text', value: formatPath(path) })
      continue
    }
    if (staged.length >= maxStaged) {
      failure = 'image count exceeds this profile\'s per-message limit'
      parts.push({ kind: 'text', value: formatPath(path) })
      continue
    }
    try {
      const value = await stage(path)
      parts.push({ kind: 'staged', value })
      staged.push(value)
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error)
      parts.push({ kind: 'text', value: formatPath(path) })
    }
  }
  return { parts, staged, failure }
}
