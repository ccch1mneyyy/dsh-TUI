import sliceAnsi from '../utils/sliceAnsi.js'
import { stringWidth } from './stringWidth.js'
import type { Styles } from './styles.js'
import { wrapAnsi } from './wrapAnsi.js'

const ELLIPSIS = '…'

// --- cross-mount wrap cache ------------------------------------------------
// wrapText is pure: (text, maxWidth, wrapType) deterministically maps to one
// output string. Yet before this cache every consumer re-wrapped from
// scratch:
//
//  - dom.ts measureTextNode seeds its per-NODE incremental cache on first
//    measure; virtualization unmounts scrolled-away rows, so scrolling back
//    re-mounts the row's Text nodes and re-runs the FULL wrap (wrap-ansi
//    tokenizes + string-width-measures every word — 100-300ms single-frame
//    yoga spikes when a row of large settled text scrolls in, the dominant
//    long-session scroll stall);
//  - render-node-to-output.ts wraps every VISIBLE text node on every full
//    paint pass (no per-node cache at all there).
//
// A content-addressed LRU here makes both paths O(1) for immutable settled
// text (Markdown memo keeps content identity stable for the whole session).
// The key embeds the raw text, so V8's content-hash Map lookup matches even
// a rebuilt string. Budget mirrors line-width-cache: whole-cache clear on
// overflow (repopulates within a frame or two).
const WRAP_CACHE_MAX_ENTRIES = 2048
const WRAP_CACHE_MAX_CHARS = 2_000_000
const wrapCache = new Map<string, string>()
let wrapCacheChars = 0
/** Values below this are not worth a cache entry (key building costs about
 *  as much as the wrap itself for trivial single-word strings). */
const WRAP_CACHE_MIN_LENGTH = 24

function cachedWrap(
  text: string,
  maxWidth: number,
  wrapType: Styles['textWrap'],
  compute: () => string,
): string {
  if (text.length < WRAP_CACHE_MIN_LENGTH) return compute()
  const key = `${maxWidth}\u0000${wrapType}\u0000${text}`
  const hit = wrapCache.get(key)
  if (hit !== undefined) return hit
  const result = compute()
  if (wrapCache.size >= WRAP_CACHE_MAX_ENTRIES || wrapCacheChars + text.length > WRAP_CACHE_MAX_CHARS) {
    wrapCache.clear()
    wrapCacheChars = 0
  }
  wrapCache.set(key, result)
  wrapCacheChars += text.length
  return result
}

// sliceAnsi may include a boundary-spanning wide char (e.g. CJK at position
// end-1 with width 2 overshoots by 1). Retry with a tighter bound once.
function sliceFit(text: string, start: number, end: number): string {
  const s = sliceAnsi(text, start, end)
  return stringWidth(s) > end - start ? sliceAnsi(text, start, end - 1) : s
}

function truncate(
  text: string,
  columns: number,
  position: 'start' | 'middle' | 'end',
): string {
  if (columns < 1) return ''
  if (columns === 1) return ELLIPSIS

  const length = stringWidth(text)
  if (length <= columns) return text

  if (position === 'start') {
    return ELLIPSIS + sliceFit(text, length - columns + 1, length)
  }
  if (position === 'middle') {
    const half = Math.floor(columns / 2)
    return (
      sliceFit(text, 0, half) +
      ELLIPSIS +
      sliceFit(text, length - (columns - half) + 1, length)
    )
  }
  return sliceFit(text, 0, columns - 1) + ELLIPSIS
}

/**
 * Wrap or truncate text to a maximum width according to a textWrap style.
 * @param text - the text to fit.
 * @param maxWidth - the maximum display width in columns.
 * @param wrapType - the textWrap style: wrap, wrap-trim, truncate, truncate-start, or truncate-middle.
 * @returns the wrapped or truncated text, or `text` unchanged when no wrapping applies.
 */
export default function wrapText(
  text: string,
  maxWidth: number,
  wrapType: Styles['textWrap'],
): string {
  if (wrapType === 'wrap') {
    return cachedWrap(text, maxWidth, wrapType, () =>
      wrapAnsi(text, maxWidth, {
        trim: false,
        hard: true,
      }),
    )
  }

  if (wrapType === 'wrap-trim') {
    return cachedWrap(text, maxWidth, wrapType, () =>
      wrapAnsi(text, maxWidth, {
        trim: true,
        hard: true,
      }),
    )
  }

  if (wrapType!.startsWith('truncate')) {
    let position: 'end' | 'middle' | 'start' = 'end'

    if (wrapType === 'truncate-middle') {
      position = 'middle'
    }

    if (wrapType === 'truncate-start') {
      position = 'start'
    }

    return cachedWrap(text, maxWidth, wrapType, () =>
      truncate(text, maxWidth, position),
    )
  }

  return text
}
