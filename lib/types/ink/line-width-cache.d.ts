/**
 * Measure the display width of a line, cached per line across calls.
 * Completed lines are immutable during streaming, so caching avoids
 * re-measuring hundreds of unchanged lines on every token.
 * @param line - the line to measure.
 * @returns the display width in terminal cells.
 */
export declare function lineWidth(line: string): number;
//# sourceMappingURL=line-width-cache.d.ts.map