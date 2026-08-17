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
  // eslint-disable-next-line no-control-regex -- deliberate: sanitize untrusted render-path text
  const flat = value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
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
