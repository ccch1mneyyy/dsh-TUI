import chalk from 'chalk'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'

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
   * Override the default blue styling of the display text — callers that
   * already painted the content (code spans keep their permission color)
   * pass the identity here so the OSC 8 wrap does not recolor it.
   */
  style?: (text: string) => string
}

/** Schemes a rendered hyperlink may point at. Anything else degrades to
 * plain display text: link targets come from model output and file
 * contents, and an arbitrary scheme would reach the OS handler on click. */
const HYPERLINK_SCHEMES = new Set(['http:', 'https:', 'dsh-file:', 'file:', 'mailto:'])

// Control characters never legitimately appear in a URL; stripping them
// before the scheme check keeps `java\x00script:` from passing as a
// relative reference and keeps the embedded URL 7-bit clean (the osc()
// exit strips again — this is the entry side of the same defense).
const URL_CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\x20]/g

// Display text keeps spaces (legitimate in link labels) but drops every
// other control character: an OSC 8 sequence smuggled into `content` would
// survive the plain-text wrap verbatim, hijack cell.hyperlink after
// tokenize, and repaint a phish link over the legitimate URL.
// Same set minus the space.
const DISPLAY_TEXT_CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g

function sanitizeHyperlinkUrl(raw: string): string | null {
  const url = raw.replace(URL_CONTROL_CHARS, '')
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)
  if (scheme === null) return null
  return HYPERLINK_SCHEMES.has(`${scheme[1].toLowerCase()}:`) ? url : null
}

/**
 * Create a clickable hyperlink using OSC 8 escape sequences.
 * Falls back to plain text if the terminal doesn't support hyperlinks.
 *
 * @param url - The URL to link to
 * @param content - Optional content to display as the link text (only when hyperlinks are supported).
 *                  If provided and hyperlinks are supported, this text is shown as a clickable link.
 *                  If hyperlinks are not supported, content is ignored and only the URL is shown.
 * @param options - Optional overrides for testing (supportsHyperlinks, style)
 * @returns The OSC 8-wrapped blue link text, or the plain URL when the terminal lacks hyperlink support.
 */
export function createHyperlink(
  url: string,
  content?: string,
  options?: HyperlinkOptions,
): string {
  const hasSupport = options?.supportsHyperlinks ?? supportsHyperlinks()
  const safeUrl = sanitizeHyperlinkUrl(url)
  if (!hasSupport || safeUrl === null) {
    // Degrade to the plain display text — for a rejected scheme that is
    // the content alone (never the raw url: `javascript:...` must not
    // reach the screen either), for a supported terminal it is the url.
    return safeUrl === null ? (content ?? '') : url
  }

  // Apply basic ANSI blue color - wrap-ansi preserves this across line breaks
  // RGB colors (like theme colors) are NOT preserved by wrap-ansi with OSC 8
  const safeContent = content?.replace(DISPLAY_TEXT_CONTROL_CHARS, '')
  const displayText = safeContent ?? safeUrl
  const style = options?.style ?? ((text: string) => chalk.blue(text))
  const coloredText = style(displayText)
  return `${OSC8_START}${safeUrl}${OSC8_END}${coloredText}${OSC8_START}${OSC8_END}`
}
