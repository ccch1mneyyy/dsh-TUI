import type { SessionKind, TitleSource } from '../dsh-adapter/sessions/index.js';
import type { Theme } from '../theme.js';
/**
 * Truncate to a terminal DISPLAY width, CJK-aware (a wide character costs two
 * columns).
 *
 * Used wherever the cut has to be exact: Ink's own `wrap="truncate"` appends
 * its ellipsis as soon as content is as wide as its box rather than wider,
 * which silently eats the last character of a row laid out at its natural
 * width — and a row that then reflows pushes every row below it down.
 *
 * @param text - Plain text, no ANSI.
 * @param maxWidth - Column budget, ellipsis included.
 * @returns `text` when it fits, otherwise a cut ending in `…`.
 */
export declare function truncateWidth(text: string, maxWidth: number): string;
/** A row laid out as `left`, blank columns, then `right`. */
export interface SpreadRow {
    /** The left-hand segment, cut only if it alone exceeds the row. */
    readonly left: string;
    /** Blank columns between the two segments; at least one. */
    readonly gap: number;
    /** The right-hand segment, cut to whatever room the left one left. */
    readonly right: string;
}
/**
 * Lay out one row with its two ends pushed apart.
 *
 * Measured in COLUMNS, which is the whole reason this is a function rather
 * than three expressions at the call site. Every string it receives is
 * localized, and in Chinese a character is two columns wide — arithmetic on
 * `.length` overstates the gap by the width of the text itself, so the row
 * overflows and the terminal either wraps it (shifting every region below it
 * down a line) or clips it (silently eating the right-hand segment). Both
 * failures are invisible to an English-only test.
 *
 * The invariant, which the regression checks exhaustively: the assembled row
 * is never wider than `columns`.
 *
 * @param left - Text pinned to the start of the row.
 * @param right - Text pinned to the end, truncated when it will not fit.
 * @param columns - Total width available.
 */
export declare function spreadRow(left: string, right: string, columns: number): SpreadRow;
/**
 * Keep the END of a string within a display width, CJK-aware.
 *
 * What a single-line editor does: the caret lives at the end, so that is the
 * part worth showing. Used where text the user is typing has to stay on ONE
 * row — a wrapped input row steals a line from the list and can push the row
 * below it off the bottom of the screen.
 *
 * @param text - Plain text, no ANSI.
 * @param maxWidth - Column budget, leading ellipsis included.
 * @returns `text` when it fits, otherwise `…` followed by its tail.
 */
export declare function tailWidth(text: string, maxWidth: number): string;
/**
 * Elapsed time as a person would say it: `just now`, `9 hours ago`, and an
 * absolute date once "ago" stops being useful.
 *
 * The cut to an absolute date is at a week rather than a month because that is
 * roughly where a relative offset stops locating anything — "23 days ago" is a
 * number to be decoded, `Mar 3` is a memory.
 *
 * @param at - Epoch ms of the moment being described.
 * @param now - Epoch ms of the present, injectable so the formatter is a pure
 *   function and its regression does not depend on a clock.
 */
export declare function formatWhen(at: number, now: number): string;
/**
 * Byte size at the precision the number is worth: `812 B`, `142.9 KB`,
 * `4.2 MB`. One decimal from kilobytes up, because the digit distinguishes a
 * short exchange from a long one and a second would not.
 */
export declare function formatBytes(bytes: number | undefined): string | undefined;
/**
 * Marker for a row's kind, or undefined for an ordinary conversation.
 *
 * Only the exceptional kinds are marked. A badge on every row would cost a
 * column of width and teach nothing — what a reader needs to see at a glance
 * is which rows are *not* the thing they came for.
 */
export declare function kindMark(kind: SessionKind): {
    glyph: string;
    color: keyof Theme;
} | undefined;
/**
 * Wrap to a display width, CJK-aware.
 *
 * Greedy, breaking on a space when one is available in the line just filled
 * and mid-character when it is not — which is the correct behaviour for CJK,
 * where there are no spaces to break on and a word-only wrapper would emit one
 * enormous unbreakable line. Newlines in the input are honoured.
 *
 * @param text - Plain text, no ANSI.
 * @param width - Column budget per line.
 * @returns The wrapped lines, never empty for non-empty input.
 */
export declare function wrapWidth(text: string, width: number): string[];
/** Human name of a session kind, for the preview pane's header. */
export declare function kindLabel(kind: SessionKind): string;
/**
 * Colour for a title, by how much is actually known about it.
 *
 * A title the user chose is stated plainly; one a model generated reads the
 * same, because it is a real title; a first-prompt excerpt is dimmer, because
 * it is the session speaking rather than a name; a directory basename is
 * dimmest of all, because it says only "nothing here was readable".
 */
export declare function titleColor(source: TitleSource, focused: boolean): keyof Theme;
/**
 * Project label for a group header: the working directory, with `$HOME`
 * collapsed to `~` so the eye lands on the part that differs.
 */
export declare function formatProject(cwd: string, home: string): string;
//# sourceMappingURL=format.d.ts.map