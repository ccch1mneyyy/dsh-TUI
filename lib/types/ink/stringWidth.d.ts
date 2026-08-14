/**
 * Get the display width of a string as it would appear in a terminal.
 *
 * Uses Bun.stringWidth when available; otherwise falls back to the JS
 * implementation above, which strips ANSI codes and handles emoji, wide
 * characters, and zero-width combining marks.
 * @param str - the string to measure.
 * @returns the number of terminal cells the string occupies.
 */
export declare const stringWidth: (str: string) => number;
//# sourceMappingURL=stringWidth.d.ts.map