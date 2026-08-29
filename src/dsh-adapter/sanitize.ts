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
