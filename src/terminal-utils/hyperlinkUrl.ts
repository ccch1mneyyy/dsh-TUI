/** Schemes accepted both by link construction and by raw OSC 8 rendering. */
const HYPERLINK_SCHEMES = new Set(['http:', 'https:', 'dsh-file:', 'file:', 'mailto:'])

// Preserve the constructor's existing normalization: remove control bytes
// before checking the scheme, then encode spaces without retargeting paths.
const URL_CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g

/** Normalize a rendered hyperlink target, or reject an unsupported scheme.
 * Pure policy module: the cell renderer must not import theme/styling state. */
export function sanitizeHyperlinkUrl(raw: string): string | null {
  const stripped = raw.replace(URL_CONTROL_CHARS, '')
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped)
  if (scheme === null) return null
  if (!HYPERLINK_SCHEMES.has(`${scheme[1].toLowerCase()}:`)) return null
  return stripped.replaceAll(' ', '%20')
}
