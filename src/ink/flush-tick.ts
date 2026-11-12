/**
 * Monotonic terminal-flush counter for the Ink-based renderer.
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

/** Capture this frame's presentation waiters before enqueueing its write.
 * Later commits cannot claim an older queued frame's completion. */
export function takeTerminalFlushWaiters(stdout: NodeJS.WriteStream): ((error?: Error | null) => void) | undefined {
  const pending = flushWaiters.get(stdout)
  if (pending === undefined || pending.size === 0) return undefined
  flushWaiters.delete(stdout)
  return error => {
    if (error !== undefined && error !== null) return
    for (const notify of pending) notify()
  }
}

// Scoped to the renderer's output: another app's frame cannot acknowledge this
// app's content. A waiter is consumed by one completed terminal write only.
const flushWaiters = new WeakMap<NodeJS.WriteStream, Set<() => void>>()

/** Subscribe during React's mutation phase, before resetAfterCommit can flush.
 * Cleanup also cancels a queued callback if a newer commit removes the card. */
export function afterNextTerminalFlush(stdout: NodeJS.WriteStream, callback: () => void): () => void {
  let active = true
  const notify = () => { queueMicrotask(() => { if (active) callback() }) }
  let pending = flushWaiters.get(stdout)
  if (pending === undefined) { pending = new Set(); flushWaiters.set(stdout, pending) }
  pending.add(notify)
  return () => { active = false; pending.delete(notify) }
}

/** Current flush tick. Consumers capture it when they widen state and only
 *  tighten again once the tick has advanced (a frame flushed since). */
export function getTerminalFlushTick(): number {
  return flushTick
}
