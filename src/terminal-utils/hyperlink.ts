import chalk from 'chalk'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { colorize } from '../ink/colorize.js'
import { getActiveTheme } from '../theme.js'

// OSC 8 hyperlink escape sequences
// Format: \e]8;;URL\e\\TEXT\e]8;;\e\\
// Using \x07 (BEL) as terminator which is more widely supported
/** OSC 8 hyperlink start sequence: `ESC ] 8 ; ;`, followed by the URL. */
export const OSC8_START = '\x1b]8;;'
/** OSC 8 hyperlink terminator: BEL (`\x07`), more widely supported than the ST variant. */
export const OSC8_END = '\x07'

type HyperlinkOptions = {
  supportsHyperlinks?: boolean
  /**
   * Override the default link styling of the display text. Callers that
   * already painted the content (code spans keep their permission color)
   * pass the identity here so the OSC 8 wrap does not recolor it.
   */
  style?: (text: string) => string
}

/**
 * Default link style: the active palette's `accent`. It used to be a fixed
 * ANSI blue, i.e. the one color in the transcript that no theme could reach.
 * An unresolved accent (empty or malformed) still falls back to blue so a
 * link never renders as plain text.
 *
 * Wrapping is a non-issue for the color: `wrap-ansi` re-emits the active SGR
 * on every continuation line and re-pairs the OSC 8 runs, so a truecolor
 * label keeps its accent across the break.
 */
function defaultLinkStyle(text: string): string {
  const accent = getActiveTheme().accent
  const painted = accent === '' ? text : colorize(text, accent, 'foreground')
  return painted === text ? chalk.blue(text) : painted
}

/** Schemes a rendered hyperlink may point at. Anything else degrades to
 * plain display text: link targets come from model output and file
 * contents, and an arbitrary scheme would reach the OS handler on click. */
const HYPERLINK_SCHEMES = new Set(['http:', 'https:', 'dsh-file:', 'file:', 'mailto:'])

// Control characters never legitimately appear in a URL; stripping them
// before the scheme check keeps `java\x00script:` from passing as a
// relative reference and keeps the embedded URL 7-bit clean (the osc()
// exit strips again — this is the entry side of the same defense). Spaces
// are stripped for the scheme check but preserved as %20 in the embedded
// URL — deleting them would retarget `file:///C:/My Project/x`.
const URL_CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g

function sanitizeHyperlinkUrl(raw: string): string | null {
  const stripped = raw.replace(URL_CONTROL_CHARS, '')
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped)
  if (scheme === null) return null
  if (!HYPERLINK_SCHEMES.has(`${scheme[1].toLowerCase()}:`)) return null
  return stripped.replaceAll(' ', '%20')
}

// Display text keeps spaces (legitimate in link labels) but drops every
// escape sequence and leftover control character: an OSC 8 sequence
// smuggled into `content` would survive the plain-text wrap verbatim,
// hijack cell.hyperlink after tokenize, and repaint a phish link over the
// legitimate URL. Stripping COMPLETE ANSI sequences (not just the ESC byte)
// also keeps the display clean when a caller passes an already-painted
// string — the SGR parameter text would otherwise appear on screen as
// literal `[38;2;…m` garbage.
const DISPLAY_TEXT_CONTROL_CHARS =
  /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\x00-\x1f\x7f-\x9f]/g

/**
 * Create a clickable hyperlink using OSC 8 escape sequences.
 * Falls back to plain text if the terminal doesn't support hyperlinks.
 *
 * @param url - The URL to link to
 * @param content - Optional content to display as the link text (only when hyperlinks are supported).
 *                  If provided and hyperlinks are supported, this text is shown as a clickable link.
 *                  If hyperlinks are not supported, content is ignored and only the URL is shown.
 * @param options - Optional overrides for testing (supportsHyperlinks, style)
 * @returns The OSC 8-wrapped link text (accent-colored by default), or the plain URL when the terminal lacks hyperlink support.
 */
export function createHyperlink(
  url: string,
  content?: string,
  options?: HyperlinkOptions,
): string {
  const hasSupport = options?.supportsHyperlinks ?? supportsHyperlinks()
  const safeUrl = sanitizeHyperlinkUrl(url)
  // Sanitized up front so BOTH degrade paths emit clean text too: non-TTY
  // and log destinations bypass the cell-layer escape stripping, so a raw
  // url/content with control characters would escape there.
  const safeContent = content?.replace(DISPLAY_TEXT_CONTROL_CHARS, '')
  if (!hasSupport || safeUrl === null) {
    // Degrade to the plain display text — for a rejected scheme that is
    // the content alone (never the raw url: `javascript:...` must not
    // reach the screen either), for a supported terminal it is the
    // control-stripped url (safeUrl).
    return safeUrl === null ? (safeContent ?? '') : safeUrl
  }

  // The active theme's accent (see defaultLinkStyle), applied here so the
  // wrap pass receives an already-styled, OSC 8-wrapped label.
  const displayText = safeContent ?? safeUrl
  const style = options?.style ?? defaultLinkStyle
  const coloredText = style(displayText)
  return `${OSC8_START}${safeUrl}${OSC8_END}${coloredText}${OSC8_START}${OSC8_END}`
}
