/**
 * Expand tab characters to spaces at fixed column intervals, preserving
 * escape sequences and resetting the column on newlines.
 * @param text - the text to expand.
 * @param interval - the tab stop interval in columns; defaults to 8.
 * @returns `text` with every tab replaced by the spaces needed to reach the next stop.
 */
export declare function expandTabs(text: string, interval?: number): string;
//# sourceMappingURL=tabstops.d.ts.map