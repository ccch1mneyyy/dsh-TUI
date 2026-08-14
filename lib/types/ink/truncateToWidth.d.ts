/**
 * Slice a string to at most `maxWidth` terminal cells, walking by code
 * point so CJK wide characters never split mid-glyph. Assumes no ANSI in
 * the input (callers pass plain text).
 */
export declare function truncateToWidth(text: string, maxWidth: number): string;
//# sourceMappingURL=truncateToWidth.d.ts.map