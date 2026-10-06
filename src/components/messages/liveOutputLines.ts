/**
 * The running card's view of a tool's live output (`ToolRow.liveOutput`,
 * N4): the newest few lines of the bounded tail, sanitized and cut to the
 * card's width in terminal cells, plus how many older lines are not shown.
 *
 * Only the shown lines are touched: the tail is scanned backwards for its
 * last line breaks, never split whole, so the per-render cost does not
 * grow with the tail. Each shown line is sanitized for the render path:
 *
 *  - a carriage return rewrites its line (progress bars): the line shows
 *    its last state, the text after the final `\r`;
 *  - ANSI escape sequences (colours, cursor moves, OSC links) and every
 *    other control character are removed; tabs become spaces;
 *  - the line is cut to the width budget in display cells (CJK and emoji
 *    count double) with a trailing `…`, so one row never wraps.
 */
import stripAnsi from 'strip-ansi'
import { LIVE_OUTPUT_MAX_LINES } from '../../channel/live-output.js'
import { truncateToWidth } from '../../ink/truncateToWidth.js'

/** Live lines a running card shows inline. */
export const LIVE_OUTPUT_LINES_INLINE = 5
/** Live lines a running card shows in fullscreen. */
export const LIVE_OUTPUT_LINES_FULLSCREEN = 8

/** How many live lines a card shows: the whole retained tail when
 *  verbose (Ctrl+O / expanded), else 5 inline and 8 in fullscreen. */
export function liveOutputMaxLines(verbose: boolean, fullscreen: boolean): number {
  if (verbose) return LIVE_OUTPUT_MAX_LINES
  return fullscreen ? LIVE_OUTPUT_LINES_FULLSCREEN : LIVE_OUTPUT_LINES_INLINE
}

/** What the card renders of a live tail. */
export interface LiveOutputView {
  /** Older lines not shown (dropped by the tail bound, or retained but
   *  above the shown window). */
  readonly omitted: number
  /** The newest lines, oldest first, each one terminal row. */
  readonly lines: readonly string[]
}

const TAB = '    '

/** One raw output line as the card may paint it (uncut). */
export function cleanOutputLine(raw: string): string {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  const carriage = line.lastIndexOf('\r')
  if (carriage !== -1) line = line.slice(carriage + 1)
  // eslint-disable-next-line no-control-regex -- deliberate: untrusted process output on the render path
  return stripAnsi(line).replace(/\t/gu, TAB).replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/gu, '')
}

/** Cut a clean line to `width` cells, marking a cut with `…`. */
export function fitOutputLine(line: string, width: number): string {
  const budget = Math.max(1, width)
  // truncateToWidth walks code points only until the budget is exceeded,
  // so a 16 KiB line costs no more than a short one.
  const head = truncateToWidth(line, budget)
  if (head.length === line.length) return line
  return `${truncateToWidth(head, budget - 1)}…`
}

/** Lines in a tail (a trailing break closes the last line). */
function lineCount(text: string): number {
  if (text === '') return 0
  let breaks = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) breaks += 1
  return breaks + (text.endsWith('\n') ? 0 : 1)
}

/**
 * Rows the live block of a card paints (the omitted header plus the shown
 * lines): the card's height input for the transcript's layout signature.
 * Scans back at most `maxLines + 1` line breaks, so it stays cheap per
 * frame however long the tail is.
 */
export function liveOutputRows(text: string | undefined, dropped: number, maxLines: number): number {
  if (text === undefined || text === '' || maxLines <= 0) return 0
  let shown = 0
  let more = false
  let end = text.endsWith('\n') ? text.length - 1 : text.length
  while (end >= 0) {
    if (shown === maxLines) {
      more = true
      break
    }
    shown += 1
    end = end === 0 ? -1 : text.lastIndexOf('\n', end - 1)
  }
  return shown + (more || dropped > 0 ? 1 : 0)
}

/**
 * The newest `maxLines` lines of a tail, cleaned and fitted to `width`
 * cells, with the count of older lines (`dropped` = lines the tail bound
 * already discarded).
 */
export function liveOutputView(text: string, dropped: number, maxLines: number, width: number): LiveOutputView {
  if (text === '' || maxLines <= 0) return { omitted: dropped + lineCount(text), lines: [] }
  const newest: string[] = []
  let end = text.endsWith('\n') ? text.length - 1 : text.length
  while (end >= 0 && newest.length < maxLines) {
    const brk = end === 0 ? -1 : text.lastIndexOf('\n', end - 1)
    newest.push(text.slice(brk + 1, end))
    end = brk
  }
  newest.reverse()
  const lines = newest.map(line => fitOutputLine(cleanOutputLine(line), width))
  return { omitted: dropped + lineCount(text) - newest.length, lines }
}
