/**
 * Monotonic terminal-flush counter for the ported Ink core.
 *
 * React commits and terminal writes are decoupled: `scheduleRender`
 * throttles `onRender` to the frame budget with a deferred leading edge, so
 * a commit can be SUPERSEDED by a later commit inside the same task before
 * its layout ever reaches the terminal (the generation guard in
 * `deferredRender` drops the stale leading frame). Components that treat
 * "mounted" as "painted" (main-screen scrollback keeps no copy of a row the
 * window skipped) then lose content: the row unmounted before a single byte
 * of it was written.
 *
 * `noteTerminalFlush()` increments once per completed `writeDiffToTerminal`;
 * consumers compare the tick to decide whether the layout they committed
 * has actually been flushed (issue #574: cold-start history vanished on
 * fast machines exactly because the 120ms wall-clock hold expired during
 * the first commit's ~190ms of cold-cached yoga before any flush ran).
 */

/** Flush counter — see the module comment. */
let flushTick = 0

/** Record one completed terminal frame write. Called from ink's onRender
 *  after writeDiffToTerminal; test harnesses that bypass ink and write
 *  frames directly may call it manually to keep consumers in step. */
export function noteTerminalFlush(): void {
  flushTick++
}

/** Current flush tick. Consumers capture it when they widen state and only
 *  tighten again once the tick has advanced (a frame flushed since). */
export function getTerminalFlushTick(): number {
  return flushTick
}
