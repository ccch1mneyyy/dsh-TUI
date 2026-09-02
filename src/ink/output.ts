import {
  type AnsiCode,
  ansiCodesToString,
  type StyledChar,
  styledCharsFromTokens,
  tokenize,
} from '@alcalzone/ansi-tokenize'
import { logForDebugging } from '../utils/debug.js'
import { getGraphemeSegmenter } from '../utils/intl.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { reorderBidi } from './bidi.js'
import { type Rectangle, unionRect } from './layout/geometry.js'
import {
  blitRegion,
  cellRunSpan,
  CellWidth,
  createCellRun,
  extractHyperlinkFromStyles,
  filterOutHyperlinkStyles,
  markNoSelectRegion,
  OSC8_PREFIX,
  recordCellRunEntry,
  recordSpacerRunEntry,
  replayCellRun,
  resetScreen,
  type Screen,
  type StylePool,
  setCellAt,
  shiftRows,
  type CellRun,
} from './screen.js'
import { stringWidth } from './stringWidth.js'
import { widestLine } from './widest-line.js'

/**
 * A grapheme cluster with precomputed terminal width, styleId, and hyperlink.
 * Built once per unique line (cached via charCache), so the per-char hot loop
 * is just property reads + setCellAt — no stringWidth, no style interning,
 * no hyperlink extraction per frame.
 *
 * styleId is safe to cache: StylePool is session-lived (never reset).
 * hyperlink is stored as a string (not interned ID) since hyperlinkPool
 * resets every 5 min; setCellAt interns it per-frame (cheap Map.get).
 */
type ClusteredChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}

/**
 * charCache bounds. The entry-count cap alone was not enough: a streaming
 * line produces a NEW cache key on every frame, and each entry's cost is
 * proportional to the line length (one object per character, plus the key
 * string itself). A 16384-entry cache of 80KB-line entries is tens of GB —
 * the process OOMs long before reaching the count cap. Two extra guards:
 *
 * 1. Lines longer than MAX_CACHEABLE_LINE are never cached. During
 *    streaming the growing last line changes every frame, so a cached
 *    entry would be used for exactly one frame — pure cost, zero hits.
 *    Long lines are also rare in settled transcripts (minified code,
 *    base64, URLs), so skipping them barely affects the hit rate.
 * 2. A byte budget (total characters of cached keys) caps retained
 *    memory regardless of the entry size distribution.
 *
 * Keys are detached from their parent string before caching: a line
 * sliced out of a large streaming buffer is a V8 SlicedString that pins
 * the whole parent, turning one 200-char entry into a 100KB retention.
 */
const MAX_CACHEABLE_LINE = 500
const CHAR_CACHE_MAX_ENTRIES = 16384
const CHAR_CACHE_MAX_CHARS = 100_000

/** Packed-run line cap: runs are three integers per cell (no per-char
 *  objects like charCache entries), so long ANSI-art lines (the whale
 *  logo, ~700 chars) are worth caching — they would otherwise
 *  re-tokenize and re-cluster every frame. */
const PACKED_MAX_LINE = 4000

/** Copy a string into a fresh flat string with no parent references. */
function detachString(s: string): string {
  // Buffer round-trip guarantees a newly allocated flat string; cheaper
  // tricks (' '+s).slice(1) are optimized back into SlicedStrings by V8.
  return Buffer.from(s, 'utf8').toString('utf8')
}

/**
 * Bounded cache of line → clustered characters. Enforces all three guards
 * (line-length threshold, entry count, byte budget) at insertion time, so
 * no caller can accidentally grow it unboundedly.
 */
export class CharCache {
  /**
   * LRU of line → clustered characters. A full clear on overflow
   * (the original behavior) thrashes during long-session streaming: the
   * mounted window's static lines alone approach the char budget, so the
   * streaming row's per-frame new keys tip it over every frame or two,
   * nuking the cache and forcing ~1800 line re-tokenizations per frame
   * (measured ~100ms/frame at a 175-row session). Evicting oldest-first
   * keeps the hot mounted lines resident while streaming churn falls out
   * the back. Recency is refreshed on hit (delete + re-insert) so lines
   * read every frame are never evicted by one-shot churn.
   */
  private map = new Map<string, ClusteredChar[]>()
  private chars = 0

  /**
   * Return the cached clustered characters for a line, if present, and
   * refresh the entry's recency.
   * @param line - the line to look up.
   * @returns the cached characters, or undefined on a miss.
   */
  get(line: string): ClusteredChar[] | undefined {
    const hit = this.map.get(line)
    if (hit !== undefined) {
      this.map.delete(line)
      this.map.set(line, hit)
    }
    return hit
  }

  /**
   * Cache clustered characters for a line, enforcing the cache bounds by
   * evicting least-recently-used entries (never a full clear).
   * @param line - the line key.
   * @param characters - the clustered characters to cache.
   */
  set(line: string, characters: ClusteredChar[]): void {
    if (line.length > MAX_CACHEABLE_LINE) return
    if (this.map.has(line)) {
      this.map.delete(line)
      this.chars -= line.length
    }
    // Evict oldest entries until the new one fits. A single line longer
    // than the whole budget cannot fit even empty — skip caching it.
    if (line.length > CHAR_CACHE_MAX_CHARS) return
    while (
      this.map.size >= CHAR_CACHE_MAX_ENTRIES ||
      this.chars + line.length > CHAR_CACHE_MAX_CHARS
    ) {
      const oldest = this.map.keys().next()
      if (oldest.done === true) break
      const oldestKey = oldest.value
      this.chars -= oldestKey.length
      this.map.delete(oldestKey)
    }
    this.map.set(detachString(line), characters)
    this.chars += line.length
  }

  /** Retained-key character total, exposed for diagnostics/tests. */
  get retainedChars(): number {
    return this.chars
  }

  /** Number of cached line entries. */
  get size(): number {
    return this.map.size
  }
}

/**
 * Collects write/blit/clear/clip operations from the render tree, then
 * applies them to a Screen buffer in get(). The Screen is what gets
 * diffed against the previous frame to produce terminal updates.
 */
type Options = {
  width: number
  height: number
  stylePool: StylePool
  /**
   * Screen to render into. Will be reset before use.
   * For double-buffering, pass a reusable screen. Otherwise create a new one.
   */
  screen: Screen
}

/** A queued paint operation: write, clip, unclip, blit, clear, noSelect, or shift. */
export type Operation =
  | WriteOperation
  | ClipOperation
  | UnclipOperation
  | BlitOperation
  | ClearOperation
  | NoSelectOperation
  | ShiftOperation

type WriteOperation = {
  type: 'write'
  x: number
  y: number
  text: string
  /**
   * Per-line soft-wrap flags, parallel to text.split('\n'). softWrap[i]=true
   * means line i is a continuation of line i-1 (the `\n` before it was
   * inserted by word-wrap, not in the source). Index 0 is always false.
   * Undefined means the producer didn't track wrapping (e.g. fills,
   * raw-ansi) — the screen's per-row bitmap is left untouched.
   */
  softWrap?: boolean[]
}

type ClipOperation = {
  type: 'clip'
  clip: Clip
}

/** A rectangular clip region; undefined on an axis means unbounded. */
export type Clip = {
  x1: number | undefined
  x2: number | undefined
  y1: number | undefined
  y2: number | undefined
}

/**
 * Intersect two clips. `undefined` on an axis means unbounded; the other
 * clip's bound wins. If both are bounded, take the tighter constraint
 * (max of mins, min of maxes). If the resulting region is empty
 * (x1 >= x2 or y1 >= y2), writes clipped by it will be dropped.
 */
function intersectClip(parent: Clip | undefined, child: Clip): Clip {
  if (!parent) return child
  return {
    x1: maxDefined(parent.x1, child.x1),
    x2: minDefined(parent.x2, child.x2),
    y1: maxDefined(parent.y1, child.y1),
    y2: minDefined(parent.y2, child.y2),
  }
}

function maxDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

function minDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

type UnclipOperation = {
  type: 'unclip'
}

type BlitOperation = {
  type: 'blit'
  src: Screen
  x: number
  y: number
  width: number
  height: number
}

type ShiftOperation = {
  type: 'shift'
  top: number
  bottom: number
  n: number
}

type ClearOperation = {
  type: 'clear'
  region: Rectangle
  /**
   * Set when the clear is for an absolute-positioned node's old bounds.
   * Absolute nodes overlay normal-flow siblings, so their stale paint is
   * what an earlier sibling's clean-subtree blit wrongly restores from
   * prevScreen. Normal-flow siblings' clears don't have this problem —
   * their old position can't have been painted on top of a sibling.
   */
  fromAbsolute?: boolean
}

type NoSelectOperation = {
  type: 'noSelect'
  region: Rectangle
}

/**
 * Single-slot cache for the one over-long line that grows every frame during
 * streaming (the current stream tail). CharCache excludes such lines
 * (MAX_CACHEABLE_LINE) because a cached entry is used for exactly one frame
 * - so without this slot, every frame re-runs tokenize + grapheme clustering
 * + bidi over the WHOLE line even though only a few characters were appended.
 * The slot lets a frame that strictly extends the previous frame's line reuse
 * the prefix clustering and only process the appended suffix.
 */
type StreamingLineSlot = {
  line: string
  clustered: ClusteredChar[]
  /** SGR state at end of line (styles of the last styled char) - replayed
   * before the suffix so appended characters inherit the right style. */
  trailingStyles: AnsiCode[]
}

type EscapeTailState = 'none' | 'complete' | 'dangling' | 'bare'

/**
 * Slot-reuse ceiling: the clustered array is a second full memory image of
 * the line, and pathological single-line output (base64 blobs, minified
 * code) would pin it across frames on top of the string itself. Past this
 * length every frame takes the full path — transient, GC-able.
 */
const STREAMING_SLOT_MAX_LINE = 65_536

/**
 * Classify the tail of the line relative to its LAST ESC character.
 * - 'none': no ESC at all
 * - 'dangling': the last ESC starts an escape sequence that is cut off at
 *   end-of-line - next frame's continuation completes it, so the prefix
 *   clustering cannot be reused (the partial sequence was clustered as text)
 * - 'bare': the last ESC's sequence is complete but ends exactly at
 *   end-of-line - the SGR state after it never applied to any character, so
 *   trailingStyles (derived from the last char) would be stale next frame
 * - 'complete': last sequence terminated with plain text after it
 */
function escapeTailState(line: string): EscapeTailState {
  const i = line.lastIndexOf('\x1b')
  if (i === -1) return 'none'
  const rest = line.slice(i)
  const c1 = rest[1]
  if (c1 === undefined) return 'dangling'
  if (c1 === '[') {
    for (let k = 2; k < rest.length; k++) {
      const ch = rest.charCodeAt(k)
      if (ch >= 0x40 && ch <= 0x7e) return k === rest.length - 1 ? 'bare' : 'complete'
      if (ch < 0x20 || ch > 0x3f) return 'complete'
    }
    return 'dangling'
  }
  if (c1 === ']' || c1 === 'P' || c1 === '_' || c1 === '^' || c1 === 'X') {
    for (let k = 2; k < rest.length; k++) {
      if (rest[k] === '\x07') return k === rest.length - 1 ? 'bare' : 'complete'
      if (rest[k] === '\x1b' && rest[k + 1] === '\\') {
        return k + 1 === rest.length - 1 ? 'bare' : 'complete'
      }
    }
    return 'dangling'
  }
  // Two-character sequence ESC <0x30-0x7E>: rest.length >= 2 means complete.
  return rest.length === 2 ? 'bare' : 'complete'
}

/** True when the line's last code point may continue into a multi-codepoint
 *  grapheme (ZWJ, variation selectors, combining marks, skin tones, regional
 *  indicators) - appending to it would change the last grapheme's clustering. */
function endsWithOpenGrapheme(line: string): boolean {
  const cp = line.codePointAt(line.length - 1)
  if (cp === undefined) return false
  return (
    cp === 0x200d ||
    cp === 0xfe0f ||
    cp === 0xfe0e ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff)
  )
}

/** Hebrew / Arabic / Syriac and related RTL blocks - bidirectional reordering
 *  is line-global, so prefix-reuse (which reorders only the suffix) is not
 *  safe for these; take the full path. */
function hasRtlChars(text: string): boolean {
  return /[\u0590-\u05FF\u0600-\u06FF\u0700-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(text)
}

/** Update (or clear) the streaming slot after a full-path build of `line`.
 *  The slot is only kept when the line can safely be extended next frame. */
function updateStreamingSlot(
  slot: { current: StreamingLineSlot | null },
  line: string,
  clustered: ClusteredChar[],
  chars: StyledChar[],
): void {
  if (
    line.length <= MAX_CACHEABLE_LINE ||
    line.length > STREAMING_SLOT_MAX_LINE ||
    endsWithOpenGrapheme(line) ||
    hasRtlChars(line)
  ) {
    // Short lines are served by CharCache; complex tails always take the
    // full path. Drop a stale slot when the stream settles.
    if (slot.current) slot.current = null
    return
  }
  const tail = escapeTailState(line)
  if (tail === 'dangling' || tail === 'bare') {
    if (slot.current) slot.current = null
    return
  }
  slot.current = {
    line: detachString(line),
    clustered,
    trailingStyles: chars.length > 0 ? chars[chars.length - 1]!.styles : [],
  }
}

/**
 * Build the clustered characters for one line, taking the streaming-prefix
 * fast path when possible. `slot` is the instance-level streaming slot;
 * `prevChars`/`fullChars` wiring is handled by updateStreamingSlot.
 */
function buildClusteredChars(
  line: string,
  stylePool: StylePool,
  slot: { current: StreamingLineSlot | null },
): ClusteredChar[] {
  const prev = slot.current
  if (
    prev &&
    line.length > MAX_CACHEABLE_LINE &&
    line.length > prev.line.length &&
    line.startsWith(prev.line) &&
    !endsWithOpenGrapheme(prev.line) &&
    !hasRtlChars(line.slice(prev.line.length))
  ) {
    // Reuse the prefix clustering verbatim; tokenize only the appended
    // suffix, replaying the line-end SGR state so new characters inherit
    // the correct style. Bidi runs on the suffix alone (line verified RTL-free).
    const suffix = line.slice(prev.line.length)
    const replay = styledCharsFromTokens(
      tokenize(ansiCodesToString(prev.trailingStyles) + suffix),
    )
    const clustered = styledCharsWithGraphemeClustering(replay, stylePool)
    const result = prev.clustered.concat(
      reorderBidi(clustered),
    )
    updateStreamingSlot(slot, line, result, replay)
    return result
  }
  const chars = styledCharsFromTokens(tokenize(line))
  const clustered = reorderBidi(
    styledCharsWithGraphemeClustering(chars, stylePool),
  )
  updateStreamingSlot(slot, line, clustered, chars)
  return clustered
}

/**
 * Collects write/blit/clear/clip operations from the render tree, then
 * applies them to a Screen buffer in get(). The Screen is what gets
 * diffed against the previous frame to produce terminal updates.
 */
export default class Output {
  /** Screen width in columns. */
  width: number
  /** Screen height in rows. */
  height: number
  private readonly stylePool: StylePool
  private screen: Screen

  private readonly operations: Operation[] = []

  private charCache = new CharCache()

  /**
   * LRU of line → recorded packed cell run, mirroring charCache's bounds.
   * The main-screen architecture repaints every settled line each frame;
   * the recorded run replays as raw two-word stores (no interning, no
   * packing, no guard branches) — the long-session streaming fix. Runs are
   * validated against the screen they were interned on and die with it.
   */
  private packedLines = new Map<string, CellRun>()
  private packedChars = 0

  /** Stable owner handle passed to writeLineToScreen (no per-call closure). */
  private readonly packedOwner = {
    lines: this.packedLines,
    commit: (line: string, run: CellRun): void => {
      this.setPackedLine(line, run)
    },
  }

  /** Insert into the packed-lines LRU, evicting oldest entries on budget. */
  private setPackedLine(line: string, run: CellRun): void {
    if (line.length > PACKED_MAX_LINE) return
    if (this.packedLines.has(line)) {
      this.packedLines.delete(line)
      this.packedChars -= line.length
    }
    while (
      this.packedLines.size >= CHAR_CACHE_MAX_ENTRIES ||
      this.packedChars + line.length > CHAR_CACHE_MAX_CHARS
    ) {
      const oldest = this.packedLines.keys().next()
      if (oldest.done === true) break
      this.packedChars -= oldest.value.length
      this.packedLines.delete(oldest.value)
    }
    this.packedLines.set(detachString(line), run)
    this.packedChars += line.length
  }

  /**
   * Streaming-tail slot, shared by every writeLineToScreen call of this
   * Output (only one line grows per frame during streaming). Survives reset()
   * like charCache - it is keyed by strict line extension, so stale entries
   * can never produce a wrong hit.
   */
  private streamingSlot: { current: StreamingLineSlot | null } = { current: null }

  constructor(options: Options) {
    const { width, height, stylePool, screen } = options

    this.width = width
    this.height = height
    this.stylePool = stylePool
    this.screen = screen

    resetScreen(screen, width, height)
  }

  /**
   * Reuse this Output for a new frame. Zeroes the screen buffer, clears
   * the operation list (backing storage is retained), and caps charCache
   * growth. Preserving charCache across frames is the main win — most
   * lines don't change between renders, so tokenize + grapheme clustering
   * becomes a cache hit.
   * @param width - the new screen width in columns.
   * @param height - the new screen height in rows.
   * @param screen - the screen buffer to render into.
   */
  reset(width: number, height: number, screen: Screen): void {
    this.width = width
    this.height = height
    this.screen = screen
    this.operations.length = 0
    resetScreen(screen, width, height)
    // Bounds are enforced at insertion time (CharCache.set); nothing to
    // do here. The cache intentionally survives frames — most lines don't
    // change between renders, so tokenize + clustering becomes a hit.
  }

  /**
   * Copy cells from a source screen region (blit = block image transfer).
   * @param src - the source screen.
   * @param x - the destination left column.
   * @param y - the destination top row.
   * @param width - the region width in columns.
   * @param height - the region height in rows.
   */
  blit(src: Screen, x: number, y: number, width: number, height: number): void {
    this.operations.push({ type: 'blit', src, x, y, width, height })
  }

  /**
   * Shift full-width rows within [top, bottom] by n. n > 0 = up. Mirrors
   * what DECSTBM + SU/SD does to the terminal. Paired with blit() to reuse
   * prevScreen content during pure scroll, avoiding full child re-render.
   * @param top - the first row of the shift region.
   * @param bottom - the last row of the shift region.
   * @param n - the shift amount; positive moves content up.
   */
  shift(top: number, bottom: number, n: number): void {
    this.operations.push({ type: 'shift', top, bottom, n })
  }

  /**
   * Clear a region by writing empty cells. Used when a node shrinks to
   * ensure stale content from the previous frame is removed.
   * @param region - the region to clear.
   * @param fromAbsolute - whether the clear is for an absolute-positioned node's old bounds.
   */
  clear(region: Rectangle, fromAbsolute?: boolean): void {
    this.operations.push({ type: 'clear', region, fromAbsolute })
  }

  /**
   * Mark a region as non-selectable (excluded from fullscreen text
   * selection copy + highlight). Used by <NoSelect> to fence off
   * gutters (line numbers, diff sigils). Applied AFTER blit/write so
   * the mark wins regardless of what's blitted into the region.
   * @param region - the region to mark.
   */
  noSelect(region: Rectangle): void {
    this.operations.push({ type: 'noSelect', region })
  }

  /**
   * Queue a text write at a position, split across lines on newlines.
   * @param x - the left column.
   * @param y - the top row.
   * @param text - the text to write.
   * @param softWrap - per-line soft-wrap flags parallel to text.split('\n').
   */
  write(x: number, y: number, text: string, softWrap?: boolean[]): void {
    if (!text) {
      return
    }

    this.operations.push({
      type: 'write',
      x,
      y,
      text,
      softWrap,
    })
  }

  /**
   * Push a clip region; subsequent writes are restricted to it.
   * @param clip - the clip region to apply.
   */
  clip(clip: Clip): void {
    this.operations.push({
      type: 'clip',
      clip,
    })
  }

  /** Pop the most recent clip region. */
  unclip(): void {
    this.operations.push({
      type: 'unclip',
    })
  }

  /**
   * Apply all queued operations to the screen buffer and return it.
   * @returns the rendered screen, diffable against the previous frame.
   */
  get(): Screen {
    const screen = this.screen
    const screenWidth = this.width
    const screenHeight = this.height

    // Track blit vs write cell counts for debugging
    let blitCells = 0
    let writeCells = 0

    // Pass 1: expand damage to cover clear regions. The buffer is freshly
    // zeroed by resetScreen, so this pass only marks damage so diff()
    // checks these regions against the previous frame.
    //
    // Also collect clears from absolute-positioned nodes. An absolute
    // node overlays normal-flow siblings; when it shrinks, its clear is
    // pushed AFTER those siblings' clean-subtree blits (DOM order). The
    // blit copies the absolute node's own stale paint from prevScreen,
    // and since clear is damage-only, the ghost survives diff. Normal-
    // flow clears don't need this — a normal-flow node's old position
    // can't have been painted on top of a sibling's current position.
    const absoluteClears: Rectangle[] = []
    for (const operation of this.operations) {
      if (operation.type !== 'clear') continue
      const { x, y, width, height } = operation.region
      const startX = Math.max(0, x)
      const startY = Math.max(0, y)
      const maxX = Math.min(x + width, screenWidth)
      const maxY = Math.min(y + height, screenHeight)
      if (startX >= maxX || startY >= maxY) continue
      const rect = {
        x: startX,
        y: startY,
        width: maxX - startX,
        height: maxY - startY,
      }
      screen.damage = screen.damage ? unionRect(screen.damage, rect) : rect
      if (operation.fromAbsolute) absoluteClears.push(rect)
    }

    const clips: Clip[] = []

    for (const operation of this.operations) {
      switch (operation.type) {
        case 'clear':
          // handled in pass 1
          continue

        case 'clip':
          // Intersect with the parent clip (if any) so nested
          // overflow:hidden boxes can't write outside their ancestor's
          // clip region. Without this, a message with overflow:hidden at
          // the bottom of a scrollbox pushes its OWN clip (based on its
          // layout bounds, already translated by -scrollTop) which can
          // extend below the scrollbox viewport — writes escape into
          // the sibling bottom section's rows.
          clips.push(intersectClip(clips.at(-1), operation.clip))
          continue

        case 'unclip':
          clips.pop()
          continue

        case 'blit': {
          // Bulk-copy cells from source screen region using TypedArray.set().
          // Tracking damage ensures diff() checks blitted cells for stale content
          // when a parent blits an area that previously contained child content.
          const {
            src,
            x: regionX,
            y: regionY,
            width: regionWidth,
            height: regionHeight,
          } = operation
          // Intersect with active clip — a child's clean-blit passes its full
          // cached rect, but the parent ScrollBox may have shrunk (pill mount).
          // Without this, the blit writes past the ScrollBox's new bottom edge
          // into the pill's row.
          const clip = clips.at(-1)
          const startX = Math.max(regionX, clip?.x1 ?? 0)
          const startY = Math.max(regionY, clip?.y1 ?? 0)
          const maxY = Math.min(
            regionY + regionHeight,
            screenHeight,
            src.height,
            clip?.y2 ?? Infinity,
          )
          const maxX = Math.min(
            regionX + regionWidth,
            screenWidth,
            src.width,
            clip?.x2 ?? Infinity,
          )
          if (startX >= maxX || startY >= maxY) continue
          // Skip rows covered by an absolute-positioned node's clear.
          // Absolute nodes overlay normal-flow siblings, so prevScreen in
          // that region holds the absolute node's stale paint — blitting
          // it back would ghost. See absoluteClears collection above.
          if (absoluteClears.length === 0) {
            blitRegion(screen, src, startX, startY, maxX, maxY)
            blitCells += (maxY - startY) * (maxX - startX)
            continue
          }
          let rowStart = startY
          for (let row = startY; row <= maxY; row++) {
            const excluded =
              row < maxY &&
              absoluteClears.some(
                r =>
                  row >= r.y &&
                  row < r.y + r.height &&
                  startX >= r.x &&
                  maxX <= r.x + r.width,
              )
            if (excluded || row === maxY) {
              if (row > rowStart) {
                blitRegion(screen, src, startX, rowStart, maxX, row)
                blitCells += (row - rowStart) * (maxX - startX)
              }
              rowStart = row + 1
            }
          }
          continue
        }

        case 'shift': {
          shiftRows(screen, operation.top, operation.bottom, operation.n)
          continue
        }

        case 'write': {
          const { text, softWrap } = operation
          let { x, y } = operation
          let lines = text.split('\n')
          let swFrom = 0
          let prevContentEnd = 0

          const clip = clips.at(-1)

          if (clip) {
            const clipHorizontally =
              typeof clip?.x1 === 'number' && typeof clip?.x2 === 'number'

            const clipVertically =
              typeof clip?.y1 === 'number' && typeof clip?.y2 === 'number'

            // If text is positioned outside of clipping area altogether,
            // skip to the next operation to avoid unnecessary calculations
            if (clipHorizontally) {
              const width = widestLine(text)

              if (x + width <= clip.x1! || x >= clip.x2!) {
                continue
              }
            }

            if (clipVertically) {
              const height = lines.length

              if (y + height <= clip.y1! || y >= clip.y2!) {
                continue
              }
            }

            if (clipHorizontally) {
              lines = lines.map(line => {
                const from = x < clip.x1! ? clip.x1! - x : 0
                const width = stringWidth(line)
                const to = x + width > clip.x2! ? clip.x2! - x : width
                // Fast path: the line sits entirely inside the clip — no
                // slice needed. sliceAnsi re-tokenizes the line (the
                // dominant per-frame cost of long sessions otherwise:
                // every settled line, every frame).
                if (from === 0 && to === width) return line
                let sliced = sliceAnsi(line, from, to)
                // Wide chars (CJK, emoji) occupy 2 cells. When `to` lands
                // on the first cell of a wide char, sliceAnsi includes the
                // entire glyph and the result overflows clip.x2 by one cell,
                // writing a SpacerTail into the adjacent sibling. Re-slice
                // one cell earlier; wide chars are exactly 2 cells, so a
                // single retry always fits.
                if (stringWidth(sliced) > to - from) {
                  sliced = sliceAnsi(line, from, to - 1)
                }
                return sliced
              })

              if (x < clip.x1!) {
                x = clip.x1!
              }
            }

            if (clipVertically) {
              const from = y < clip.y1! ? clip.y1! - y : 0
              const height = lines.length
              const to = y + height > clip.y2! ? clip.y2! - y : height

              // If the first visible line is a soft-wrap continuation, we
              // need the clipped previous line's content end so
              // screen.softWrap[lineY] correctly records the join point
              // even though that line's cells were never written.
              if (softWrap && from > 0 && softWrap[from] === true) {
                prevContentEnd = x + stringWidth(lines[from - 1]!)
              }

              lines = lines.slice(from, to)
              swFrom = from

              if (y < clip.y1!) {
                y = clip.y1!
              }
            }
          }

          const swBits = screen.softWrap
          let offsetY = 0

          for (const line of lines) {
            const lineY = y + offsetY
            // Line can be outside screen if `text` is taller than screen height
            if (lineY >= screenHeight) {
              break
            }
            const contentEnd = writeLineToScreen(
              screen,
              line,
              x,
              lineY,
              screenWidth,
              this.stylePool,
              this.charCache,
              this.streamingSlot,
              this.packedOwner,
            )
            writeCells += contentEnd - x
            // See Screen.softWrap docstring for the encoding. contentEnd
            // from writeLineToScreen is tab-expansion-aware, unlike
            // x+stringWidth(line) which treats tabs as width 0.
            if (softWrap) {
              const isSW = softWrap[swFrom + offsetY] === true
              swBits[lineY] = isSW ? prevContentEnd : 0
              prevContentEnd = contentEnd
            }
            offsetY++
          }
          continue
        }
      }
    }

    // noSelect ops go LAST so they win over blits (which copy noSelect
    // from prevScreen) and writes (which don't touch noSelect). This way
    // a <NoSelect> box correctly fences its region even when the parent
    // blits, and moving a <NoSelect> between frames correctly clears the
    // old region (resetScreen already zeroed the bitmap).
    for (const operation of this.operations) {
      if (operation.type === 'noSelect') {
        const { x, y, width, height } = operation.region
        markNoSelectRegion(screen, x, y, width, height)
      }
    }

    // Log blit/write ratio for debugging - high write count suggests blitting isn't working
    const totalCells = blitCells + writeCells
    if (totalCells > 1000 && writeCells > blitCells) {
      logForDebugging(
        `High write ratio: blit=${blitCells}, write=${writeCells} (${((writeCells / totalCells) * 100).toFixed(1)}% writes), screen=${screenHeight}x${screenWidth}`,
      )
    }

    return screen
  }
}

function stylesEqual(a: AnsiCode[], b: AnsiCode[]): boolean {
  if (a === b) return true // Reference equality fast path
  const len = a.length
  if (len !== b.length) return false
  if (len === 0) return true // Both empty
  for (let i = 0; i < len; i++) {
    if (a[i]!.code !== b[i]!.code) return false
  }
  return true
}

/**
 * Convert a string with ANSI codes into styled characters with proper grapheme
 * clustering. Fixes ansi-tokenize splitting grapheme clusters (like family
 * emojis) into individual code points.
 *
 * Also precomputes styleId + hyperlink per style run (not per char) — an
 * 80-char line with 3 style runs does 3 intern calls instead of 80.
 */
function styledCharsWithGraphemeClustering(
  chars: StyledChar[],
  stylePool: StylePool,
): ClusteredChar[] {
  const charCount = chars.length
  if (charCount === 0) return []

  const result: ClusteredChar[] = []
  const bufferChars: string[] = []
  let bufferStyles: AnsiCode[] = chars[0]!.styles

  for (let i = 0; i < charCount; i++) {
    const char = chars[i]!
    const styles = char.styles

    // Different styles means we need to flush and start new buffer
    if (bufferChars.length > 0 && !stylesEqual(styles, bufferStyles)) {
      flushBuffer(bufferChars.join(''), bufferStyles, stylePool, result)
      bufferChars.length = 0
    }

    bufferChars.push(char.value)
    bufferStyles = styles
  }

  // Final flush
  if (bufferChars.length > 0) {
    flushBuffer(bufferChars.join(''), bufferStyles, stylePool, result)
  }

  return result
}

function flushBuffer(
  buffer: string,
  styles: AnsiCode[],
  stylePool: StylePool,
  out: ClusteredChar[],
): void {
  // Compute styleId + hyperlink ONCE for the whole style run.
  // Every grapheme in this buffer shares the same styles.
  //
  // Extract and track hyperlinks separately, filter from styles.
  // Always check for OSC 8 codes to filter, not just when a URL is
  // extracted. The tokenizer treats OSC 8 close codes (empty URL) as
  // active styles, so they must be filtered even when no hyperlink
  // URL is present.
  const hyperlink = extractHyperlinkFromStyles(styles) ?? undefined
  const hasOsc8Styles =
    hyperlink !== undefined ||
    styles.some(
      s =>
        s.code.length >= OSC8_PREFIX.length && s.code.startsWith(OSC8_PREFIX),
    )
  const filteredStyles = hasOsc8Styles
    ? filterOutHyperlinkStyles(styles)
    : styles
  const styleId = stylePool.intern(filteredStyles)

  for (const { segment: grapheme } of getGraphemeSegmenter().segment(buffer)) {
    out.push({
      value: grapheme,
      width: stringWidth(grapheme),
      styleId,
      hyperlink,
    })
  }
}

/**
 * Write a single line's characters into the screen buffer.
 * Extracted from Output.get() so JSC can optimize this tight,
 * monomorphic loop independently — better register allocation,
 * setCellAt inlining, and type feedback than when buried inside
 * a 300-line dispatch function.
 *
 * Returns the end column (x + visual width, including tab expansion) so
 * the caller can record it in screen.softWrap without re-walking the
 * line via stringWidth(). Caller computes the debug cell-count as end-x.
 */
function writeLineToScreen(
  screen: Screen,
  line: string,
  x: number,
  y: number,
  screenWidth: number,
  stylePool: StylePool,
  charCache: CharCache,
  streamingSlot: { current: StreamingLineSlot | null },
  packed?: {
    lines: Map<string, CellRun>
    commit: (line: string, run: CellRun) => void
  },
): number {
  // Fast path: replay the recorded packed run for this exact line — two
  // typed-array stores per cell, no interning/packing/guard work. The run
  // dies with its screen; a width transition needs the slow path's guards
  // and replayCellRun reports that.
  if (packed !== undefined) {
    const run = packed.lines.get(line)
    if (
      run !== undefined &&
      run.charPool === screen.charPool &&
      x >= 0 &&
      x + cellRunSpan(run) <= screenWidth
    ) {
      if (replayCellRun(screen, x, y, run)) {
        // LRU refresh (chars budget unchanged: same key length).
        packed.lines.delete(line)
        packed.lines.set(line, run)
        return x + cellRunSpan(run)
      }
      // fall through to the slow path for this line this frame
    }
  }

  let characters = charCache.get(line)
  if (!characters) {
    characters = buildClusteredChars(line, stylePool, streamingSlot)
    charCache.set(line, characters)
  }

  // Recording for the packed fast path: only plain single/wide char cells
  // are recordable — control chars (tab expansion is x-relative), edge
  // SpacerHead substitution, and y/x off-screen abort it. The packed-run
  // limit is far above the charCache's MAX_CACHEABLE_LINE: a run costs
  // three small integers per cell (no per-char objects), so even the
  // ~700-char ANSI-art whale lines belong — without this they
  // re-tokenize and re-cluster EVERY frame.
  const recordable =
    packed !== undefined &&
    line.length <= PACKED_MAX_LINE &&
    x >= 0 &&
    y >= 0 &&
    y < screen.height
  let run = recordable ? createCellRun(screen) : undefined
  let runAlive = run !== undefined

  let offsetX = x

  for (let charIdx = 0; charIdx < characters.length; charIdx++) {
    const character = characters[charIdx]!
    const codePoint = character.value.codePointAt(0)

    // Handle C0 control characters (0x00-0x1F) that cause cursor movement
    // mismatches. stringWidth treats these as width 0, but terminals may
    // move the cursor differently.
    if (codePoint !== undefined && codePoint <= 0x1f) {
      // Not recordable: tab expansion is x-relative, ESC handling varies.
      runAlive = false
      // Tab (0x09): expand to spaces at the tab's OWN style, not stylePool.none.
      // An unstyled space drops the background and is skipped by the diff's
      // empty-cell optimization, so a tab inside a bg region (code blocks) shows
      // the terminal default bg — the black indentation of issue #606.
      if (codePoint === 0x09) {
        const tabWidth = 8
        const spacesToNextStop = tabWidth - (offsetX % tabWidth)
        for (let i = 0; i < spacesToNextStop && offsetX < screenWidth; i++) {
          setCellAt(screen, offsetX, y, {
            char: ' ',
            styleId: character.styleId,
            width: CellWidth.Narrow,
            hyperlink: undefined,
          })
          offsetX++
        }
      }
      // ESC (0x1B): skip incomplete escape sequences that ansi-tokenize
      // didn't recognize. ansi-tokenize only parses SGR sequences (ESC[...m)
      // and OSC 8 hyperlinks (ESC]8;;url BEL). Other sequences like cursor
      // movement, screen clearing, or terminal title become individual char
      // tokens that we need to skip here.
      else if (codePoint === 0x1b) {
        const nextChar = characters[charIdx + 1]?.value
        const nextCode = nextChar?.codePointAt(0)
        if (
          nextChar === '(' ||
          nextChar === ')' ||
          nextChar === '*' ||
          nextChar === '+'
        ) {
          // Charset selection: ESC ( X, ESC ) X, etc.
          // Skip the intermediate char and the charset designator
          charIdx += 2
        } else if (nextChar === '[') {
          // CSI sequence: ESC [ ... final-byte
          // Final byte is in range 0x40-0x7E (@, A-Z, [\]^_`, a-z, {|}~)
          // Examples: ESC[2J (clear), ESC[?25l (cursor hide), ESC[H (home)
          charIdx++ // skip the [
          while (charIdx < characters.length - 1) {
            charIdx++
            const c = characters[charIdx]?.value.codePointAt(0)
            // Final byte terminates the sequence
            if (c !== undefined && c >= 0x40 && c <= 0x7e) {
              break
            }
          }
        } else if (
          nextChar === ']' ||
          nextChar === 'P' ||
          nextChar === '_' ||
          nextChar === '^' ||
          nextChar === 'X'
        ) {
          // String-based sequences terminated by BEL (0x07) or ST (ESC \):
          // - OSC: ESC ] ... (Operating System Command)
          // - DCS: ESC P ... (Device Control String)
          // - APC: ESC _ ... (Application Program Command)
          // - PM:  ESC ^ ... (Privacy Message)
          // - SOS: ESC X ... (Start of String)
          charIdx++ // skip the introducer char
          while (charIdx < characters.length - 1) {
            charIdx++
            const c = characters[charIdx]?.value
            // BEL (0x07) terminates the sequence
            if (c === '\x07') {
              break
            }
            // ST (String Terminator) is ESC \
            // When we see ESC, check if next char is backslash
            if (c === '\x1b') {
              const nextC = characters[charIdx + 1]?.value
              if (nextC === '\\') {
                charIdx++ // skip the backslash too
                break
              }
            }
          }
        } else if (
          nextCode !== undefined &&
          nextCode >= 0x30 &&
          nextCode <= 0x7e
        ) {
          // Single-character escape sequences: ESC followed by 0x30-0x7E
          // (excluding the multi-char introducers already handled above)
          // - Fp range (0x30-0x3F): ESC 7 (save cursor), ESC 8 (restore)
          // - Fe range (0x40-0x5F): ESC D (index), ESC M (reverse index)
          // - Fs range (0x60-0x7E): ESC c (reset)
          charIdx++ // skip the command char
        }
      }
      // Carriage return (0x0D): would move cursor to column 0, skip it
      // Backspace (0x08): would move cursor left, skip it
      // Bell (0x07), vertical tab (0x0B), form feed (0x0C): skip
      // All other control chars (0x00-0x06, 0x0E-0x1F): skip
      // Note: newline (0x0A) is already handled by line splitting
      continue
    }

    // Zero-width characters (combining marks, ZWNJ, ZWS, etc.)
    // don't occupy terminal cells — storing them as Narrow cells
    // desyncs the virtual cursor from the real terminal cursor.
    // Width was computed once during clustering (cached via charCache).
    const charWidth = character.width
    if (charWidth === 0) {
      continue
    }

    const isWideCharacter = charWidth >= 2

    // Wide char at last column can't fit — terminal would wrap it to
    // the next line, desyncing our cursor model. Place a SpacerHead to
    // mark the blank column, matching terminal behavior.
    if (isWideCharacter && offsetX + 2 > screenWidth) {
      runAlive = false
      setCellAt(screen, offsetX, y, {
        char: ' ',
        styleId: stylePool.none,
        width: CellWidth.SpacerHead,
        hyperlink: undefined,
      })
      offsetX++
      continue
    }

    // styleId + hyperlink were precomputed during clustering (once per
    // style run, cached via charCache). Hot loop is now just property
    // reads — no intern, no extract, no filter per frame.
    const cellWidth = isWideCharacter ? CellWidth.Wide : CellWidth.Narrow
    setCellAt(screen, offsetX, y, {
      char: character.value,
      styleId: character.styleId,
      width: cellWidth,
      hyperlink: character.hyperlink,
    })
    if (runAlive && run !== undefined) {
      recordCellRunEntry(run, screen, offsetX, {
        char: character.value,
        styleId: character.styleId,
        width: cellWidth,
        hyperlink: character.hyperlink,
      })
      // setCellAt also writes a SpacerTail after a wide char (when it
      // fits); record that deterministic write too, or abort at the edge.
      if (isWideCharacter) {
        if (offsetX + 1 < screenWidth) {
          recordSpacerRunEntry(run, offsetX + 1)
        } else {
          runAlive = false
        }
      }
    }
    offsetX += isWideCharacter ? 2 : 1
  }

  // Commit the recording for the packed fast path. Complete NON-EMPTY
  // runs only: an empty line ('' from split('\n'), zero-width-only lines)
  // records zero entries and would commit a degenerate run whose replay
  // writes NaN damage (gaps[0] undefined) and poisons the whole frame diff.
  if (runAlive && run !== undefined && packed !== undefined && run.gaps.length > 0) {
    packed.commit(line, run)
  }

  return offsetX
}
