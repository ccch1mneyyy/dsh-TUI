/**
 * Clickable file targets: turning path-like text in AI output into
 * clickable targets, and resolving those targets back to absolute paths at
 * click time.
 *
 * Two URL shapes are produced / accepted:
 * - `dsh-file:<encodeURIComponent(path)>` — our own scheme. The payload is
 *   the RAW displayed path (possibly relative, possibly Windows-style), so
 *   nothing is lost in transit and it resolves against the CURRENT
 *   workspace at click time (paths in a long-lived session may outlive the
 *   cwd they were written under).
 * - `file://…` — real file URLs the model may emit in markdown; decoded
 *   with node:url and treated the same way.
 *
 * `looksLikeFilePath` is deliberately conservative: it must be obviously a
 * path (slash + no whitespace + anchor or extension), otherwise prose like
 * "and/or" or "2024/01/15" would light up as clickable everywhere.
 */
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

/** Our custom OSC 8 scheme carrying a raw display path (URI-encoded). */
export const FILE_LINK_SCHEME = 'dsh-file:'

/** Encode a display path into a `dsh-file:` link URL. */
export function fileLinkUrl(path: string): string {
  return FILE_LINK_SCHEME + encodeURIComponent(path)
}

/**
 * Decode a `dsh-file:` link URL back to the raw display path. Returns
 * undefined for anything that is not a well-formed dsh-file URL.
 */
export function parseFileLinkUrl(url: string): string | undefined {
  if (!url.startsWith(FILE_LINK_SCHEME)) return undefined
  try {
    return decodeURIComponent(url.slice(FILE_LINK_SCHEME.length))
  } catch {
    return undefined
  }
}

/**
 * Resolve a target (raw display path) against the session's base directory:
 * absolute paths and `~` pass through (with ~ expanded), everything else is
 * joined onto the base. Pure, so it is unit-testable without a workspace.
 */
export function resolveTargetPath(path: string, baseDir: string): string {
  if (path === '') return path
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  if (path === '~') return homedir()
  // Windows drive-absolute (`C:\…`, `C:/…`) is absolute regardless of
  // platform; node:path.isAbsolute handles the current platform only, so
  // probe both separators explicitly.
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    return path
  }
  return resolve(baseDir, path)
}

/**
 * Convert a `file://` URL to a local path. Wraps node:url.fileURLToPath —
 * undefined when the URL is not a valid file URL.
 */
export function fileUrlToPath(url: string): string | undefined {
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

/** Known source/config/data file extensions — the conservative allowlist. */
const FILE_EXTENSION_RE = /\.([A-Za-z0-9]{1,6})$/u

/** A path is worth linking when it carries one of these anchors, or has a
 *  known-extension tail. */
const PATH_ANCHOR_RE = /^(\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/u

/** Stoplist for extension-like tails that are TLDs / prose words, not
 *  file extensions (`github.com/foo` must not link as a file). */
const NON_EXTENSION_TAILS = new Set([
  'com', 'org', 'net', 'io', 'dev', 'app', 'edu', 'gov', 'mil', 'co', 'uk', 'cn',
])

/** A dot-suffix of up to 6 alphanumerics is a plausible extension when at
 *  least 4 chars precede it (`a/b.x`-style prose fragments and short
 *  `x/y.ts` guesses must not false-positive). */
function hasPlausibleExtension(stripped: string): boolean {
  const extMatch = FILE_EXTENSION_RE.exec(stripped)
  if (extMatch === null) return false
  const ext = extMatch[1]!.toLowerCase()
  if (NON_EXTENSION_TAILS.has(ext)) return false
  return stripped.slice(0, extMatch.index).length >= 4
}

/**
 * Conservative heuristic: does this text look like a file path worth
 * making clickable? Requires a slash separator, no whitespace, no URL/email
 * shape, and either a path anchor (`./`, `../`, `/`, `~/`, drive letter)
 * with a real path shape (another separator or an extension — a bare
 * anchored word like `/a` or `x.com/a` is too ambiguous), or a plausible
 * file extension. Length-capped so huge tokens (base64, logs) never get
 * linked.
 */
export function looksLikeFilePath(text: string): boolean {
  const t = text.trim()
  if (t.length < 2 || t.length > 200) return false
  if (!t.includes('/') && !t.includes('\\')) return false
  if (/\s/u.test(t)) return false
  if (/[<>"'`|?*]/.test(t)) return false
  // URLs (any scheme://, incl. file://) and emails are handled by their
  // own linkifiers.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(t) || /^www\./iu.test(t)) return false
  if (t.includes('@')) return false
  if (/[#\u0000-\u001f]/u.test(t)) return false

  // Strip one layer of trailing punctuation so "foo/bar.ts." still links.
  const stripped = t.replace(/[.,;:!?]+$/u, '')
  if (stripped === '') return false
  const separators = (stripped.match(/[\\/]/gu) ?? []).length
  if (PATH_ANCHOR_RE.test(stripped)) {
    return separators >= 2 || hasPlausibleExtension(stripped)
  }
  return hasPlausibleExtension(stripped)
}

/**
 * Best-effort existence hint: does `path` exist on disk? Used to decide
 * whether to render a path as clickable in contexts where the raw text is
 * ambiguous; never throws.
 */
export function pathExistsOnDisk(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * Candidate-span scanner: anchored paths (`./`, `../`, `/`, `~/`, drive)
 * run to the end of the word; everything else must contain a slash AND a
 * dot-extension tail. This is only a pre-filter — every span is then
 * verified by `looksLikeFilePath` before it becomes clickable.
 */
const PATH_SPAN_RE =
  /(?:\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])[^\s<>"'`|?#]*|(?:[^\s<>"'`|?#]*[\\/][^\s<>"'`|?#]*\.[A-Za-z0-9]{1,6})/gu

/**
 * Replace every path-looking span in `text` via `wrap(path, display)`.
 * Trailing sentence punctuation stays OUTSIDE the wrapped display (so
 * "src/foo.ts." links `src/foo.ts` and keeps the period). Spans that fail
 * `looksLikeFilePath` are returned unchanged.
 * @param text - plain text to scan (no ANSI).
 * @param wrap - builds the clickable rendering for one path.
 */
export function linkifyFilePaths(
  text: string,
  wrap: (path: string, display: string) => string,
): string {
  return text.replace(PATH_SPAN_RE, (match, offset, full) => {
    // The slash-anchor branch would otherwise match inside URLs
    // (`https:/…` matches `/…`): a span glued to a scheme colon or a `//`
    // run is part of a URL, never a path. offset is available because the
    // regex has no capture groups.
    if (offset > 0) {
      const prev = full[offset - 1]!
      if (prev === ':' || prev === '/') return match
    }
    const display = match.replace(/[.,;:!?]+$/u, '')
    if (display === '' || !looksLikeFilePath(display)) return match
    return wrap(display, display) + match.slice(display.length)
  })
}
