/**
 * The render-path sanitization contract for plugin-supplied text — the
 * single implementation behind every managed-UI seam (dialogs, status line,
 * entry renderers, rewind modes, decision notices). TUI-PROP-009 Track A
 * makes these rules normative, so they live in exactly one place:
 *
 * - C0/C1 control chars are stripped (replaced by a space) — plugin text
 *   must never smuggle escape sequences onto the screen;
 * - whitespace collapses to single spaces (render paths are single-line);
 * - width is capped in terminal CELLS (never string.length) with an
 *   ellipsis.
 *
 * Non-scalar input is DROPPED, never `String()`-coerced — `String({})`
 * would put "[object Object]" on the render path. Scalars
 * (string/number/boolean) coerce through String() first.
 */

import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../utils/intl.js'

/** Sanitize an already-string value for the render path. */
export function cleanRenderText(value: string, maxCells: number): string {
  // Remove complete ANSI control sequences before stripping control bytes.
  // Otherwise an SGR such as ESC[31m becomes the visible garbage "[31m".
  const withoutAnsi = value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  // eslint-disable-next-line no-control-regex -- deliberate: sanitize untrusted render-path text
  const flat = withoutAnsi.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (stringWidth(flat) <= maxCells) return flat
  let out = ''
  for (const ch of flat) {
    if (stringWidth(out + ch) > maxCells - 1) break
    out += ch
  }
  return `${out}…`
}

/**
 * Sanitize untrusted plugin text destined for a MULTI-LINE block (a
 * `pushLocal` report): the same per-line strip as {@link cleanRenderText},
 * but newlines are structure here, not whitespace to fold. Blank rows are
 * dropped so one reported line stays one transcript row.
 */
export function cleanBlockLines(value: string, maxCells: number): string[] {
  return value.split(/\r?\n/u).map(line => cleanRenderText(line, maxCells)).filter(line => line !== '')
}

/** Bounded, local-only registry output. Explicit command blocks keep the
 * existing cleanBlockLines contract; reports retain indentation and empty rows. */
export function cleanCommandReport(value: string): { lines: string[]; truncated: boolean } {
  const maxCodeUnits = 65_536
  const maxLines = 200
  const maxCells = 4000
  let bounded = value.slice(0, maxCodeUnits)
  // Do not split a Unicode scalar at the allocation boundary.
  if (bounded.length < value.length && /[\uD800-\uDBFF]$/u.test(bounded)) bounded = bounded.slice(0, -1)
  let truncated = bounded.length < value.length
  const rows = bounded.split(/\r?\n/u)
  if (rows.length > maxLines) truncated = true
  const lines = rows.slice(0, maxLines).map(row => {
    const plain = flattenPasteInline(row)
    if (stringWidth(plain) <= maxCells) return plain
    truncated = true
    let clipped = ''
    let cells = 0
    for (const { segment } of getGraphemeSegmenter().segment(plain)) {
      const width = stringWidth(segment)
      if (cells + width > maxCells - 1) break
      clipped += segment
      cells += width
    }
    return `${clipped}…`
  })
  return { lines: value === '' ? [] : lines, truncated }
}

/**
 * Sanitize an untrusted (possibly non-string) value. Non-scalars — objects,
 * arrays, functions, symbols, null/undefined — yield '' so the caller takes
 * its drop/refuse path; scalars coerce then sanitize.
 */
export function cleanScalarText(value: unknown, maxCells: number): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
  return cleanRenderText(String(value), maxCells)
}

/**
 * Truncate to a cell budget WITHOUT ellipsis, whitespace folding, or any
 * other mutation — the editing-path counterpart of {@link cleanRenderText}.
 * An input panel caps what the user types/pastes; inserting '…' or
 * collapsing their spaces would corrupt text they can still edit.
 */
export function capCells(value: string, maxCells: number): string {
  if (stringWidth(value) <= maxCells) return value
  let out = ''
  for (const ch of value) {
    if (stringWidth(out + ch) > maxCells) break
    out += ch
  }
  return out
}

/** C0/C1 control chars → space, nothing else touched. The single-line
 *  input panel flattens pasted chunks with this (newlines become spaces —
 *  the panel has no second row for them). */
export function flattenInline(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberate: sanitize untrusted render-path text
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
}

/**
 * Single-line field ingress for terminal/clipboard paste: strip COMPLETE
 * ANSI/OSC sequences first (paste content is user-controlled bytes — a
 * smuggled ESC[… would otherwise break out of the render path), then flatten
 * every remaining C0/C1 control char to a space. Unlike {@link flattenInline},
 * this never leaves `[31m`-style residue behind; the two regexes mirror
 * {@link cleanRenderText}'s strip, and the final pass covers the rest.
 */
export function flattenPasteInline(value: string): string {
  const withoutAnsi = value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  return flattenInline(withoutAnsi)
}

/** Bidi overrides/isolates and invisible separators: invisible, and a single
 *  U+202E next to a host field (`#sessionId`, cwd) can flip the displayed
 *  direction of the text that follows it. Footer fields sit immediately
 *  beside those provenance tags, so they strip this class first.
 *
 *  The joiners U+200C (ZWNJ) and U+200D (ZWJ) are deliberately NOT in it:
 *  they are orthographic (Persian, Indic) and compose emoji sequences, so
 *  stripping them would rewrite the plugin's text and inflate its cell
 *  width (a ZWJ family emoji measures 2 cells, 6 without the joiners). */
const BIDI_AND_INVISIBLE_MARKS = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu

/**
 * Footer-field ingress: the common render cleanup PLUS bidi controls and
 * invisible separators. Kept separate from {@link cleanRenderText} so the
 * existing managed-UI callers keep their exact behaviour. Non-scalars yield
 * '' (the caller decides between refuse and clear); scalars coerce then
 * sanitize.
 */
export function cleanStatusFieldText(value: unknown, maxCells: number): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
  return cleanRenderText(String(value).replace(BIDI_AND_INVISIBLE_MARKS, ''), maxCells)
}

/** Toast-bound plugin text (veto reasons, handled notices, rewind summaries)
 *  and single-line transcript notices are render-path data too: same
 *  sanitization, toast-width cap. */
export const NOTICE_CELLS = 200
