/**
 * The bounded live-output tail of a running tool (`tool.output`, N4): the
 * shared projector appends every chunk here and publishes the retained
 * text on the tool row; the card renders the newest few lines of it.
 *
 * Bounded twice, so a chatty command can never grow the row: at most
 * {@link LIVE_OUTPUT_MAX_LINES} lines and {@link LIVE_OUTPUT_MAX_CHARS}
 * characters (16 KiB counted in UTF-16 code units). Whole lines leave from
 * the head first and are counted in `dropped`; a single line longer than
 * the whole budget keeps its newest characters (cut on a code-point
 * boundary). The text stays raw (ANSI, carriage returns): sanitizing is
 * the renderer's job, over the few lines it actually shows.
 *
 * Pure and allocation-light: an append scans only the new chunk for line
 * breaks (the running count rides on the tail) plus one slice when a
 * bound is crossed.
 */

/** Lines a tail keeps. */
export const LIVE_OUTPUT_MAX_LINES = 200
/** Characters a tail keeps (16 KiB of UTF-16 code units). */
export const LIVE_OUTPUT_MAX_CHARS = 16 * 1024

/** One running call's retained output. */
export interface LiveOutputTail {
  /** The retained text, oldest first; the last line may still be open. */
  readonly text: string
  /** Line breaks in `text` (kept so an append never rescans the tail). */
  readonly breaks: number
  /** Whole lines dropped from the head so far. */
  readonly dropped: number
}

/** Line breaks in `text[from, to)`. */
function countBreaks(text: string, from = 0, to = text.length): number {
  let count = 0
  for (let at = text.indexOf('\n', from); at !== -1 && at < to; at = text.indexOf('\n', at + 1)) count += 1
  return count
}

/** Lines in a tail's text (a trailing break closes the last line). */
export function liveOutputLineCount(tail: Pick<LiveOutputTail, 'text' | 'breaks'>): number {
  if (tail.text === '') return 0
  return tail.breaks + (tail.text.endsWith('\n') ? 0 : 1)
}

/** Append one chunk, keeping the tail within both bounds. */
export function appendLiveOutput(tail: LiveOutputTail | undefined, chunk: string): LiveOutputTail {
  let text = (tail?.text ?? '') + chunk
  let breaks = (tail?.breaks ?? 0) + countBreaks(chunk)
  let dropped = tail?.dropped ?? 0
  const lines = liveOutputLineCount({ text, breaks })
  if (lines > LIVE_OUTPUT_MAX_LINES) {
    const excess = lines - LIVE_OUTPUT_MAX_LINES
    let cut = 0
    for (let index = 0; index < excess; index += 1) cut = text.indexOf('\n', cut) + 1
    text = text.slice(cut)
    breaks -= excess
    dropped += excess
  }
  if (text.length > LIVE_OUTPUT_MAX_CHARS) {
    const from = text.length - LIVE_OUTPUT_MAX_CHARS
    // The first line that starts inside the budget: a break at from - 1 or
    // later. When that break is the text's last character (one huge closed
    // line) or there is none (one huge open line), the newest line itself
    // is clipped instead.
    const at = text.indexOf('\n', Math.max(0, from - 1))
    let start: number
    if (at !== -1 && at + 1 < text.length) {
      start = at + 1
    } else {
      start = from
      const code = text.charCodeAt(start)
      // Never start on the low half of a surrogate pair.
      if (code >= 0xdc00 && code <= 0xdfff) start += 1
    }
    const removed = countBreaks(text, 0, start)
    text = text.slice(start)
    breaks -= removed
    dropped += removed
  }
  return { text, breaks, dropped }
}
