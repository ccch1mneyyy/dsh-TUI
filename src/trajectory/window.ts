/**
 * Ledger windowing — the trajectory's shared windowing math (design
 * agent-team-panels §4 完整档: 长会话虚拟化; the dock-row listWindow
 * precedent applied to the ledger).
 *
 * The ledger NEVER renders the whole session: both hosts (the fullscreen
 * scene and the side panel) paint exactly one viewport's worth of rows and
 * keep the focused row visible, so a ten-thousand-row session costs the
 * same frame as a ten-row one. The math lived twice, hand-rolled with the
 * same clamp; one named, tested function now owns it — the properties the
 * regression locks:
 *
 * - the window is rows tall (or as tall as the list allows);
 * - the focused row sits inside it, centered while room allows;
 * - it never starts before 0 nor past the last full page;
 * - an empty list windows to (0, rows) and paints nothing.
 */

/**
 * The cursor-centered ledger window.
 *
 * @param count - Length of the (possibly filtered) row list.
 * @param cursor - Focused row index (clamped here; callers may hold a
 *   stale cursor for one frame after a filter narrows the list).
 * @param rows - Viewport row budget (>= 1).
 * @returns start = first painted row index, end = one past the last
 *   (may exceed count; slicing on end is always safe).
 */
export function ledgerWindow(count: number, cursor: number, rows: number): { start: number; end: number } {
  const height = Math.max(1, rows)
  const clamped = count === 0 ? 0 : Math.max(0, Math.min(cursor, count - 1))
  const start = Math.max(0, Math.min(clamped - Math.floor(height / 2), Math.max(0, count - height)))
  return { start, end: start + height }
}
