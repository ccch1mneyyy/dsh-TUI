import type { ReactElement } from 'react';
import { type Screen, StylePool } from './screen.js';
/** Position of a match within a rendered message, relative to the message's
 *  own bounding box (row 0 = message top). Stable across scroll — to
 *  highlight on the real screen, add the message's screen-row offset. */
export type MatchPosition = {
    row: number;
    col: number;
    /** Number of CELLS the match spans (= query.length for ASCII, more
     *  for wide chars in the query). */
    len: number;
};
/** Render a React element (wrapped in all contexts the component needs —
 *  caller's job) to an isolated Screen buffer at the given width. Returns
 *  the Screen + natural height (from yoga). Used for search: render ONE
 *  message, scan its Screen for the query, get exact (row, col) positions.
 *
 *  ~1-3ms per call (yoga alloc + calculateLayout + paint). The
 *  flushSyncWork cross-root leak measured ~0.0003ms/call growth — fine
 *  for on-demand single-message rendering, pathological for render-all-
 *  8k-upfront. Cache per (msg, query, width) upstream.
 *
 *  Unmounts between calls. Root/container/pools persist for reuse.
 *
 * @param el - the React element to render.
 * @param width - the render width in columns.
 * @returns the painted screen buffer and the yoga-computed content height.
 */
export declare function renderToScreen(el: ReactElement, width: number): {
    screen: Screen;
    height: number;
};
/** Scan a Screen buffer for all occurrences of query. Returns positions
 *  relative to the buffer (row 0 = buffer top). Same cell-skip logic as
 *  applySearchHighlight (SpacerTail/SpacerHead/noSelect) so positions
 *  match what the overlay highlight would find. Case-insensitive.
 *
 *  For the side-render use: this Screen is the FULL message (natural
 *  height, not viewport-clipped). Positions are stable — to highlight
 *  on the real screen, add the message's screen offset (lo).
 *
 * @param screen - the screen buffer to scan.
 * @param query - the substring to search for, matched case-insensitively.
 * @returns the match positions relative to the buffer, or an empty list.
 */
export declare function scanPositions(screen: Screen, query: string): MatchPosition[];
/** Write CURRENT (yellow+bold+underline) at positions[currentIdx] +
 *  rowOffset. OTHER positions are NOT styled here — the scan-highlight
 *  (applySearchHighlight with null hint) does inverse for all visible
 *  matches, including these. Two-layer: scan = 'you could go here',
 *  position = 'you ARE here'. Writing inverse again here would be a
 *  no-op (withInverse idempotent) but wasted work.
 *
 *  Positions are message-relative (row 0 = message top). rowOffset =
 *  message's current screen-top (lo). Clips outside [0, height).
 *
 * @param screen - the screen buffer to style.
 * @param stylePool - the style pool providing the current-match transform.
 * @param positions - the message-relative match positions.
 * @param rowOffset - the message's current screen-top row.
 * @param currentIdx - index into positions of the match to highlight.
 * @returns true when the highlight was written, false when out of range.
 */
export declare function applyPositionedHighlight(screen: Screen, stylePool: StylePool, positions: MatchPosition[], rowOffset: number, currentIdx: number): boolean;
//# sourceMappingURL=render-to-screen.d.ts.map