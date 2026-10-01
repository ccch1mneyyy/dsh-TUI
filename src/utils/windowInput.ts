import { stringWidth } from '../ink/stringWidth.js'

/**
 * Window a single-line input around the caret so the visible slice fits
 * `avail` display cells (CJK display width, code-point safe — `[...s]`
 * iterates code points, not UTF-16 units). The caret character itself
 * always stays inside the window: leading characters are dropped until
 * before-caret text + caret fit, then after-caret text fills what remains.
 * `offset` arrives in UTF-16 units (callers move the caret by key count);
 * a mid-surrogate offset would split an emoji, so it snaps back to the
 * pair's start first.
 */
export function windowInput(
  query: string,
  offset: number,
  avail: number,
): { before: string; at: string; after: string; caretColumn: number } {
  const budget = Math.max(avail, 1)
  let caret = Math.max(0, Math.min(offset, query.length))
  if (
    caret > 0 &&
    caret < query.length &&
    query.charCodeAt(caret - 1) >= 0xd800 &&
    query.charCodeAt(caret - 1) <= 0xdbff &&
    query.charCodeAt(caret) >= 0xdc00 &&
    query.charCodeAt(caret) <= 0xdfff
  ) {
    caret-- // mid-surrogate: snap to the emoji's start
  }
  const beforeChars = [...query.slice(0, caret)]
  const at = caret < query.length ? [...query.slice(caret)][0]! : ' '
  const atWidth = Math.max(1, stringWidth(at))
  let caretColumn = 0
  for (const ch of beforeChars) caretColumn += stringWidth(ch)
  let start = 0
  while (start < beforeChars.length && caretColumn + atWidth > budget) {
    caretColumn -= stringWidth(beforeChars[start]!)
    start++
  }
  let rest = budget - caretColumn - atWidth
  let after = ''
  for (const ch of [...query.slice(caret + at.length)]) {
    const w = stringWidth(ch)
    if (w > rest) break
    after += ch
    rest -= w
  }
  return { before: beforeChars.slice(start).join(''), at, after, caretColumn }
}
