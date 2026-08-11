import { type Screen, type StylePool } from './screen.js';
/**
 * Highlight all visible occurrences of `query` in the screen buffer by
 * inverting cell styles (SGR 7). Post-render, same damage-tracking machinery
 * as applySelectionOverlay — the diff picks up highlighted cells as ordinary
 * changes, LogUpdate stays a pure diff engine.
 *
 * Case-insensitive. Handles wide characters (CJK, emoji) by building a
 * col-of-char map per row — the Nth character isn't at col N when wide chars
 * are present (each occupies 2 cells: head + SpacerTail).
 *
 * This ONLY inverts — there is no "current match" logic here. The yellow
 * current-match overlay is handled separately by applyPositionedHighlight
 * (render-to-screen.ts), which writes on top using positions scanned from
 * the target message's DOM subtree.
 *
 * Returns true if any match was highlighted (damage gate — caller forces
 * full-frame damage when true).
 * @param screen - the screen buffer to search and update.
 * @param query - the case-insensitive search text; empty queries are a no-op.
 * @param stylePool - the style pool providing the inverted style id.
 * @returns true when at least one occurrence was highlighted.
 */
export declare function applySearchHighlight(screen: Screen, query: string, stylePool: StylePool): boolean;
//# sourceMappingURL=searchHighlight.d.ts.map