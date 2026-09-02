/**
 * Smooth streaming reveal — decouples "text the provider has delivered" from
 * "text the screen is showing" (the oh-my-pi `display.smoothStreaming` idea,
 * see their `StreamingRevealController`). A shared ~30fps scheduler advances
 * each reveal cursor by an adaptive catch-up step, so burst-delivered text (a
 * slow provider dumping a large batch, or a non-streaming response arriving
 * whole) paints as a brief even flow instead of one jarring jump, while
 * genuinely streaming text is re-paced to a steady cadence regardless of
 * chunk timing.
 *
 * Step math (per frame): `max(MIN_STEP, ceil(backlog / CATCHUP_FRAMES))` —
 * an EXPONENTIAL decay over the backlog (each frame removes ~1/8 of what is
 * still unrevealed, the oh-my-pi semantics exactly): a large burst lands its
 * first three quarters within a few frames, the remainder tapers, and the
 * MIN_STEP floor turns the tail into a steady linear crawl so the reveal
 * always finishes. A ~2000-character one-shot delivery paints fully in
 * roughly 1.5s; genuinely streaming text (small backlogs) paces at a steady
 * per-frame rate. The reveal never runs ahead of what has arrived.
 *
 * ARCHITECTURE — module-level cursors, not component state. dsh-tui's
 * transcript virtualization feeds on MemoRow prop changes (flattened
 * primitives) and re-measures mounted rows after every MessageList commit;
 * a reveal living in child-component state would change row heights without
 * touching those props, and the memo/signature/height-measure chain would
 * never notice (stale cached heights → blank bands). Instead the cursors
 * live here keyed by row identity, the READS happen during render (they feed
 * the same flattened `text` prop the streaming path already uses), and the
 * WRITES happen on the scheduler tick, which bumps a version that
 * MessageList subscribes to via useSyncExternalStore. A reveal therefore
 * rides the exact same update pipeline as an arriving chunk: prop change →
 * memo miss → re-render → post-commit measurement. Render-phase reads are
 * idempotent and safe to re-run (a discarded concurrent render at worst
 * creates a cursor the tick soon retires).
 *
 * Unit model: reveal positions are UTF-16 code units (Chinese text is one
 * unit per character). Surrogate pairs are never split (see {@link
 * safeSliceEnd}); grapheme clusters longer than a surrogate pair (emoji ZWJ
 * chains) may briefly show a partial cluster mid-reveal — transient frames
 * repaint within 33ms, and settled rendering is always the full text.
 */
import { registerOverflowQuench, swallowNestedUpdateOverflow } from '../ink/update-overflow-guard.js'

/** Reveal tick cadence — ~30fps, matching oh-my-pi's controller. */
export const REVEAL_FRAME_MS = 1000 / 30
/** Minimum units (code units or lines) advanced per tick while work remains. */
export const REVEAL_MIN_STEP = 3
/** Catch-up bound: the reveal settles any backlog within this many frames. */
export const REVEAL_CATCHUP_FRAMES = 8

/** Adaptive per-frame step for a backlog (exported for tests). */
export function revealStep(backlog: number): number {
  return Math.max(REVEAL_MIN_STEP, Math.ceil(Math.max(0, backlog) / REVEAL_CATCHUP_FRAMES))
}

/**
 * Slice boundary guard: never split a surrogate pair. When the boundary lands
 * between a high and a low surrogate, take the pair if the low half has
 * arrived, otherwise step back one unit — showing one fewer character for a
 * frame beats feeding a lone surrogate into markdown rendering.
 */
function safeSliceEnd(text: string, end: number): number {
  if (end <= 0) return 0
  if (end >= text.length) return text.length
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) {
    return end + 1 < text.length ? end + 1 : end - 1
  }
  return end
}

// ---------------------------------------------------------------------------
// Cursor tables
// ---------------------------------------------------------------------------

/** Text cursor: `text` doubles as the append basis for replacement checks. */
type TextCursor = { text: string; revealed: number }
/** Numeric cursor (tool-card body line counts). */
type CountCursor = { total: number; revealed: number }

const textCursors = new Map<string, TextCursor>()
const countCursors = new Map<string, CountCursor>()
/**
 * Keys whose reveal has COMPLETED (caught up, snapped, or replaced). A
 * completed key must not re-create a cursor on a later active read — the
 * content is already fully on screen, and re-revealing would blank it and
 * typewrite again. Bounded FIFO: well past the cap these are all ancient
 * history (the row ids are gone); dropping the oldest half only risks a
 * long-unmounted row re-revealing, which is harmless (it paints full via
 * the active=false path anyway once unmounted... and a remounted streaming
 * row WANTS the reveal).
 */
const completedReveals = new Set<string>()
const COMPLETED_REVEALS_MAX = 2048

function markRevealCompleted(key: string): void {
  if (completedReveals.size >= COMPLETED_REVEALS_MAX) {
    let drop = COMPLETED_REVEALS_MAX / 2
    for (const old of completedReveals) {
      if (drop-- <= 0) break
      completedReveals.delete(old)
    }
  }
  completedReveals.add(key)
}

// ---------------------------------------------------------------------------
// Scheduler + version store (useSyncExternalStore-compatible)
// ---------------------------------------------------------------------------

let revealTimer: ReturnType<typeof setInterval> | undefined = undefined
let revealVersionValue = 0
const revealListeners = new Set<() => void>()

function ensureRevealTimer(): void {
  if (revealTimer === undefined) {
    revealTimer = setInterval(revealTick, REVEAL_FRAME_MS)
    revealTimer.unref?.()
  }
}

function stopRevealTimerIfIdle(): void {
  if (textCursors.size === 0 && countCursors.size === 0 && revealTimer !== undefined) {
    clearInterval(revealTimer)
    revealTimer = undefined
  }
}

// Circuit-breaker quench: a sustained #185 oscillation surfacing at the
// reveal tick pauses this scheduler for the backoff window (cursors freeze
// in place; the resume timer — or a later render reading an active cursor —
// restarts it). Absorbing forever would leave the process alive but laggy.
registerOverflowQuench('reveal.tick', ms => {
  if (revealTimer !== undefined) {
    clearInterval(revealTimer)
    revealTimer = undefined
    const resume = setTimeout(() => {
      if (revealTimer === undefined && (textCursors.size > 0 || countCursors.size > 0)) {
        ensureRevealTimer()
      }
    }, ms)
    resume.unref?.()
  }
})

function revealTick(): void {
  let advanced = false
  for (const [key, cursor] of textCursors) {
    const total = cursor.text.length
    if (cursor.revealed >= total) {
      textCursors.delete(key)
      markRevealCompleted(key)
      continue
    }
    cursor.revealed = Math.min(total, cursor.revealed + revealStep(total - cursor.revealed))
    advanced = true
  }
  for (const [key, cursor] of countCursors) {
    if (cursor.revealed >= cursor.total) {
      countCursors.delete(key)
      markRevealCompleted(key)
      continue
    }
    cursor.revealed = Math.min(cursor.total, cursor.revealed + revealStep(cursor.total - cursor.revealed))
    advanced = true
  }
  if (advanced) {
    revealVersionValue += 1
    // #185 self-heal: a forceStoreRerender enqueue can surface the overflow
    // here; React resets the counter on throw, so absorb and drop the tick.
    for (const listener of [...revealListeners]) {
      try {
        listener()
      } catch (error) {
        if (!swallowNestedUpdateOverflow(error, 'reveal.tick')) throw error
      }
    }
  } else {
    stopRevealTimerIfIdle()
  }
}

/** Subscribe to reveal-frame wakeups (MessageList + tool cards). */
export function subscribeReveal(listener: () => void): () => void {
  revealListeners.add(listener)
  return () => {
    revealListeners.delete(listener)
  }
}

/** Snapshot for useSyncExternalStore; bumps once per advancing tick. */
export function getRevealVersion(): number {
  return revealVersionValue
}

/** Force-complete (and forget) a cursor: expanded card, replaced view, … */
export function snapReveal(key: string): void {
  if (textCursors.delete(key) || countCursors.delete(key)) markRevealCompleted(key)
}

// ---------------------------------------------------------------------------
// Render-phase reads
// ---------------------------------------------------------------------------

export type RevealReadOptions = {
  /** Master switch (settings `dsh-tui.smoothStreaming`); false = full text. */
  enabled: boolean
  /**
   * Whether this content arrived "just now" (live streaming row, freshly
   * settled row, live-created tool card). The FIRST read with active=true
   * creates the cursor at zero — that is what turns a one-shot
   * non-streaming delivery into a smooth paint. Reading with active=false
   * (history / replayed content) never creates one: replaying a transcript
   * must not typewrite every row. `active` only matters for cursor creation;
   * settling mid-reveal deliberately keeps revealing (the "non-streaming
   * becomes streaming" contract).
   */
  active: boolean
}

/**
 * Revealed length of `text` for `key` — the cursor logic of
 * {@link revealTextOf} without the slice allocation (layout signatures read
 * this every render for every visible row).
 */
export function revealLengthOf(key: string, text: string, options: RevealReadOptions): number {
  if (!options.enabled) {
    // Mid-stream settings toggle off: retire any cursor, show everything.
    if (textCursors.delete(key)) {
      markRevealCompleted(key)
      stopRevealTimerIfIdle()
    }
    return text.length
  }
  const existing = textCursors.get(key)
  if (existing === undefined) {
    // Completed earlier (caught up / snapped / replaced): paint full — a
    // re-reveal would blank the already-complete content and typewrite it
    // again.
    if (completedReveals.has(key)) return text.length
    if (!options.active) return text.length
    textCursors.set(key, { text, revealed: 0 })
    ensureRevealTimer()
    return 0
  }
  if (text !== existing.text) {
    if (text.startsWith(existing.text)) {
      existing.text = text
      ensureRevealTimer()
    } else {
      // Replacement: snap to the new text in full.
      textCursors.delete(key)
      markRevealCompleted(key)
      stopRevealTimerIfIdle()
      return text.length
    }
  }
  return Math.min(existing.revealed, text.length)
}

/**
 * Revealed prefix of `text` for `key`. Monotonic appends (streaming deltas)
 * keep the cursor; a non-prefix replacement (rewind, folded preview
 * truncation) snaps to the new text — never animate across a discontinuity
 * the reader did not witness as streaming. Feed the result into the
 * streaming renderer (StreamingMarkdown); the monotonic prefix it receives
 * keeps its stable-prefix memoization fully effective.
 */
export function revealTextOf(key: string, text: string, options: RevealReadOptions): string {
  const len = revealLengthOf(key, text, options)
  if (len >= text.length) return text
  return text.slice(0, safeSliceEnd(text, len))
}

/**
 * Revealed unit count for `key` over `total` units (tool-card body lines,
 * split-diff rows). A SMALLER total always snaps (content that shrank is a
 * replacement, not an append); growth keeps the cursor. Callers own the
 * append-vs-replace decision for growing totals (pass a fresh key or call
 * {@link snapReveal} when the content behind the same key is replaced).
 */
export function revealLinesOf(key: string, total: number, options: RevealReadOptions): number {
  if (total <= REVEAL_MIN_STEP) {
    // Nothing worth animating (a one-line "Running…" card): retire and
    // return full — also covers total === 0.
    if (countCursors.delete(key)) {
      markRevealCompleted(key)
      stopRevealTimerIfIdle()
    }
    return total
  }
  if (!options.enabled) {
    if (countCursors.delete(key)) {
      markRevealCompleted(key)
      stopRevealTimerIfIdle()
    }
    return total
  }
  const existing = countCursors.get(key)
  if (existing === undefined) {
    if (completedReveals.has(key)) return total
    if (!options.active) return total
    countCursors.set(key, { total, revealed: 0 })
    ensureRevealTimer()
    return 0
  }
  if (total !== existing.total) {
    if (total > existing.total) {
      existing.total = total
      ensureRevealTimer()
    } else {
      countCursors.delete(key)
      markRevealCompleted(key)
      stopRevealTimerIfIdle()
      return total
    }
  }
  return Math.min(existing.revealed, total)
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** Clear every cursor/listener/timer (verify scripts between cases). */
export function resetRevealForTest(): void {
  textCursors.clear()
  countCursors.clear()
  completedReveals.clear()
  revealListeners.clear()
  if (revealTimer !== undefined) {
    clearInterval(revealTimer)
    revealTimer = undefined
  }
  revealVersionValue = 0
}

/** Whether the shared scheduler currently runs (refcount assertions). */
export function isRevealTimerRunning(): boolean {
  return revealTimer !== undefined
}
